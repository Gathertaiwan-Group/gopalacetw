import "server-only";
import { revalidateTag } from "next/cache";
import { serviceDb } from "@/lib/supabase";
import { SITE_NAME, SITE_URL } from "@/lib/env";
import {
  type ApplyInput,
  type ApplyResult,
  type EcpayConfig,
  type NotifyStore,
  buildCheckoutParams,
  configFromEnv,
  generateTradeNo,
  HOLD_MINUTES,
  testCredentialBlockReason,
  toTotalAmount,
} from "./core";

export { autoSubmitHtml, processReturnNotification, HOLD_MINUTES } from "./core";
export type { EcpayConfig } from "./core";

export const ECPAY_METHOD_ID = "ry_ecpay_credit";

/** 環境變數中的綠界設定（不論是否被防呆停用）；ReturnURL 用它驗章，才能記錄被拒的測試通知 */
export function ecpayRawConfig(): EcpayConfig | null {
  return configFromEnv(process.env);
}

/** 測試金鑰／測試環境 + 正式網域 → 原因字串（此時不開放付款、通知不標記已付款） */
export function ecpayBlockReason(cfg: EcpayConfig | null = ecpayRawConfig()): string | null {
  return cfg ? testCredentialBlockReason(cfg, SITE_URL, process.env.VERCEL_ENV) : null;
}

let warned = false;
/** 金鑰全部來自環境變數；未設定或被防呆停用 → null（前台不顯示綠界、結帳照舊建立待付款訂單） */
export function ecpayConfig(): EcpayConfig | null {
  const cfg = ecpayRawConfig();
  const block = ecpayBlockReason(cfg);
  if (block) {
    if (!warned) console.error(`[ecpay] 已停用線上付款：${block}`);
    warned = true;
    return null;
  }
  return cfg;
}

/** 同一付款嘗試的「付款確認中」期間（分鐘）：期間內不產生新的 MerchantTradeNo，避免重複刷卡 */
export const INFLIGHT_MINUTES = 15;
/** 灌單防護：同一 email／IP 在保留期間內的未付款線上訂單上限 */
export const MAX_UNPAID_PER_EMAIL = 3;
export const MAX_UNPAID_PER_IP = 5;

export type PayMethod = { id: string; title: string; description: string; button: string; ecpay: boolean };

/** 結帳頁／訂單的付款方式。綠界啟用時與舊站一致：woocommerce_ry_ecpay_credit_settings（title=信用卡、description=使用信用卡付款） */
export function paymentMethod(site: { settings: { payment?: { methods?: { id: string; title: string }[] } } }): PayMethod {
  if (ecpayConfig()) {
    const m = (site.settings.payment?.methods || []).find((x) => x.id === ECPAY_METHOD_ID);
    return { id: ECPAY_METHOD_ID, title: m?.title || "信用卡", description: "使用信用卡付款", button: "使用信用卡付款", ecpay: true };
  }
  return { id: "manual", title: "訂單成立後聯繫付款", description: "本站目前尚未開放線上付款，訂單成立後我們將與你聯繫付款方式。", button: "下單購買", ecpay: false };
}

export function payUrl(orderId: number, key: string) {
  return `/api/ecpay/pay/?id=${orderId}&key=${encodeURIComponent(key)}`;
}

/**
 * 逾期未付款訂單取消（舊站 hold stock 60 分鐘）；回傳取消筆數。失敗不影響主流程。
 * 主要由 pg_cron job site_gopalacetw_expire_holds 每 5 分鐘執行；加入購物車／結帳／付款前也各跑一次（不等排程）。
 */
export async function cancelUnpaidOrders(): Promise<number> {
  try {
    const { data } = await serviceDb().rpc("ecpay_cancel_unpaid", { p_minutes: HOLD_MINUTES });
    return Number(data) || 0;
  } catch {
    return 0;
  }
}

/** Route handler 用：取消逾期單，有釋放庫存時讓全站快取（含庫存狀態）失效。不可在頁面 render 中呼叫。 */
export async function expireHoldsInRoute(): Promise<number> {
  const n = await cancelUnpaidOrders();
  if (n > 0) {
    try {
      revalidateTag("site", { expire: 0 });
    } catch {
      /* ignore */
    }
  }
  return n;
}

export const MAX_ATTEMPTS_PER_ORDER = 20;

export type StartResult = { ok: true; params: Record<string, string>; cfg: EcpayConfig } | { ok: false; message: string; inProgress?: boolean };

export const IN_PROGRESS_MESSAGE = "付款確認中，請稍候重新整理此頁。若已完成付款，結果可能需要幾分鐘才會更新；請勿重複付款。";

/** 最近 INFLIGHT_MINUTES 分鐘內是否有尚未收到結果的付款嘗試 */
export async function paymentInProgress(orderId: number): Promise<boolean> {
  const since = new Date(Date.now() - INFLIGHT_MINUTES * 60_000).toISOString();
  const { count } = await serviceDb()
    .from("payment_attempts")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId)
    .eq("status", "created")
    .gt("created_at", since);
  return (count || 0) > 0;
}

/** 建立一筆付款嘗試（新的 MerchantTradeNo），金額由伺服器端依訂單明細重算；狀態檢查、重複付款防護與重新預留庫存都在資料庫交易內 */
export async function startPayment(orderId: number, key: string): Promise<StartResult> {
  const cfg = ecpayConfig();
  if (!cfg) return { ok: false, message: "目前未開放線上付款。" };
  const db = serviceDb();
  await cancelUnpaidOrders();
  const { data: o } = await db
    .from("orders")
    .select("id,order_key,status,total,payment_method,date_created")
    .eq("id", orderId)
    .eq("order_key", key)
    .maybeSingle();
  if (!o) return { ok: false, message: "找不到訂單。" };
  if (o.payment_method !== ECPAY_METHOD_ID) return { ok: false, message: "此訂單不適用線上付款。" };
  if (o.status === "cancelled") return { ok: false, message: "此訂單已取消（付款期限已過），請重新下單。" };
  if (!["pending", "failed"].includes(o.status)) return { ok: false, message: "此訂單已付款或無需付款。" };

  const { data: items } = await db.from("order_items").select("name,item_type,total").eq("order_id", orderId).order("id");
  const sum = (items || []).reduce((s, i) => s + Number(i.total), 0);
  if (Math.abs(sum - Number(o.total)) > 0.005) return { ok: false, message: "訂單金額異常，請聯繫我們。" };
  let amount: number;
  try {
    amount = toTotalAmount(o.total);
  } catch {
    return { ok: false, message: "訂單金額異常，請聯繫我們。" };
  }
  const first = (items || []).find((i) => i.item_type === "line_item");

  let tradeNo = "";
  for (let i = 0; i < 4 && !tradeNo; i++) {
    const t = generateTradeNo(orderId, Date.now() + i * 1000);
    const { data: r, error } = await db.rpc("ecpay_begin_attempt", {
      p_order_id: orderId,
      p_order_key: key,
      p_trade_no: t,
      p_amount: amount,
      p_env: cfg.env,
      p_inflight_minutes: INFLIGHT_MINUTES,
      p_hold_minutes: HOLD_MINUTES,
      p_max_attempts: MAX_ATTEMPTS_PER_ORDER,
    });
    if (error) {
      if (error.code === "23505") continue; // MerchantTradeNo 碰撞，換一個再試
      return { ok: false, message: "建立付款失敗，請稍後再試。" };
    }
    const res = String(r);
    if (res === "ok") tradeNo = t;
    else if (res === "in_progress") return { ok: false, inProgress: true, message: IN_PROGRESS_MESSAGE };
    else if (res === "cancelled") return { ok: false, message: "此訂單已取消（付款期限已過），請重新下單。" };
    else if (res === "too_many_attempts") return { ok: false, message: "付款嘗試次數過多，請聯繫我們。" };
    else if (res.startsWith("out_of_stock:")) return { ok: false, message: `「${res.slice(13)}」庫存不足，無法付款，請重新下單或聯繫我們。` };
    else if (res === "not_found") return { ok: false, message: "找不到訂單。" };
    else return { ok: false, message: "此訂單已付款或無需付款。" };
  }
  if (!tradeNo) return { ok: false, message: "建立付款失敗，請稍後再試。" };

  const enc = encodeURIComponent(key);
  const params = buildCheckoutParams(cfg, {
    tradeNo,
    amount,
    itemName: first?.name || SITE_NAME,
    tradeDesc: SITE_NAME,
    returnUrl: `${SITE_URL}/api/ecpay/notify/`,
    orderResultUrl: `${SITE_URL}/api/ecpay/result/?id=${orderId}&key=${enc}`,
    clientBackUrl: `${SITE_URL}/checkout-2/order-received/${orderId}/?key=${enc}`,
  });
  return { ok: true, params, cfg };
}

export const dbNotifyStore: NotifyStore = {
  async findAttempt(tradeNo) {
    const { data } = await serviceDb().from("payment_attempts").select("merchant_trade_no,order_id,amount").eq("merchant_trade_no", tradeNo).maybeSingle();
    return data ? { merchant_trade_no: data.merchant_trade_no, order_id: Number(data.order_id), amount: Number(data.amount) } : null;
  },
  async apply(i: ApplyInput): Promise<ApplyResult> {
    const { data, error } = await serviceDb().rpc("ecpay_apply_notification", {
      p_trade_no: i.tradeNo,
      p_amount: i.amount,
      p_rtn_code: i.rtnCode,
      p_rtn_msg: i.rtnMsg,
      p_ecpay_trade_no: i.ecpayTradeNo,
      p_payment_type: i.paymentType,
      p_payment_date: i.paymentDate,
      p_simulate: i.simulatePaid,
      p_count_as_paid: i.countAsPaid,
      p_block_reason: i.blockReason,
    });
    if (error) throw new Error(`ecpay_apply_notification: ${error.message}`);
    return data as ApplyResult;
  },
};
