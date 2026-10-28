import "server-only";
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
  toTotalAmount,
} from "./core";

export { autoSubmitHtml, processReturnNotification, HOLD_MINUTES } from "./core";
export type { EcpayConfig } from "./core";

export const ECPAY_METHOD_ID = "ry_ecpay_credit";

/** 金鑰全部來自環境變數；未設定 → null（前台不顯示綠界、結帳照舊建立待付款訂單） */
export function ecpayConfig(): EcpayConfig | null {
  return configFromEnv(process.env);
}

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

/** 逾期未付款訂單取消（舊站 hold stock 60 分鐘）。失敗不影響主流程。 */
export async function cancelUnpaidOrders() {
  try {
    await serviceDb().rpc("ecpay_cancel_unpaid", { p_minutes: HOLD_MINUTES });
  } catch {
    /* ignore */
  }
}

export const MAX_ATTEMPTS_PER_ORDER = 20;

export type StartResult = { ok: true; params: Record<string, string>; cfg: EcpayConfig } | { ok: false; message: string };

/** 建立一筆付款嘗試（新的 MerchantTradeNo），金額由伺服器端依訂單明細重算 */
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

  const { count } = await db.from("payment_attempts").select("id", { count: "exact", head: true }).eq("order_id", orderId);
  if ((count || 0) >= MAX_ATTEMPTS_PER_ORDER) return { ok: false, message: "付款嘗試次數過多，請聯繫我們。" };

  let tradeNo = "";
  for (let i = 0; i < 4 && !tradeNo; i++) {
    const t = generateTradeNo(orderId, Date.now() + i * 1000);
    const { error } = await db.from("payment_attempts").insert({ order_id: orderId, merchant_trade_no: t, amount, env: cfg.env });
    if (!error) tradeNo = t;
    else if (error.code !== "23505") break;
  }
  if (!tradeNo) return { ok: false, message: "建立付款失敗，請稍後再試。" };
  if (!count) await db.from("order_notes").insert({ order_id: orderId, note: "使用 綠界信用卡 付款", is_customer_note: false, added_by: "system" });
  await db.from("audit_log").insert({
    actor_type: "system",
    actor_id: "ecpay",
    action: "payment_start",
    entity_type: "order",
    entity_id: String(orderId),
    after: { merchant_trade_no: tradeNo, amount, env: cfg.env },
  });

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
    });
    if (error) throw new Error(`ecpay_apply_notification: ${error.message}`);
    return data as ApplyResult;
  },
};
