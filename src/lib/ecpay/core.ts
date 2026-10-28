// 綠界 ECPay AIO（全方位金流）核心：純函式，無框架相依，可直接用 `node --test` 測試。
// 規格來源：ecpay skill guides/13-checkmacvalue.md（CheckMacValue，SNAPSHOT 2026-03）、
// guides/01-payment-aio.md（AIO 參數／Callback 欄位），介接注意事項 https://developers.ecpay.com.tw/2858.md（2026-10-28 web_fetch）。
// 舊站行為來源：RY WooCommerce Tools（woomp 內建）ECPay gateway：trade no = 訂單ID + "TS" + 亂數 + 反轉時間戳，截 18 字；
// TradeDesc = 站名去標點；ItemName = 第一個商品名去特殊字元；UnionPay=2；IgnorePayment=WeiXin#DigitalPayment#ApplePay；NeedExtraPaidInfo=Y。
// 注意：本檔不可使用非「可抹除」的 TS 語法（enum、parameter properties），也不可 import 其他本地模組。
import { createHash, timingSafeEqual } from "node:crypto";

export type EcpayEnv = "test" | "production";
export type EcpayConfig = { merchantId: string; hashKey: string; hashIv: string; env: EcpayEnv };
export type Params = Record<string, string>;

export const GATEWAY_URL: Record<EcpayEnv, string> = {
  test: "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5",
  production: "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5",
};

/** 舊站 woocommerce_hold_stock_minutes = 60：未付款訂單 60 分鐘後取消 */
export const HOLD_MINUTES = 60;

/** 從環境變數組設定；任一缺漏或 ECPAY_ENV 不合法 → null（不顯示綠界）。 */
export function configFromEnv(env: Record<string, string | undefined>): EcpayConfig | null {
  const merchantId = (env.ECPAY_MERCHANT_ID || "").trim();
  const hashKey = (env.ECPAY_HASH_KEY || "").trim();
  const hashIv = (env.ECPAY_HASH_IV || "").trim();
  const e = (env.ECPAY_ENV || "").trim();
  if (!merchantId || !hashKey || !hashIv) return null;
  if (e !== "test" && e !== "production") return null;
  return { merchantId, hashKey, hashIv, env: e };
}

/** CheckMacValue 專用 URL encode（對應 PHP SDK UrlService::ecpayUrlEncode：urlencode → 小寫 → .NET 字元還原） */
export function ecpayUrlEncode(source: string): string {
  let s = encodeURIComponent(source).replace(/%20/g, "+").replace(/~/g, "%7e").replace(/'/g, "%27");
  s = s.toLowerCase();
  const rep: [string, string][] = [["%2d", "-"], ["%5f", "_"], ["%2e", "."], ["%21", "!"], ["%2a", "*"], ["%28", "("], ["%29", ")"]];
  for (const [a, b] of rep) s = s.split(a).join(b);
  return s;
}

/** SHA256 CheckMacValue（大寫 hex）。Key 依不分大小寫排序（PHP ksort SORT_STRING|SORT_FLAG_CASE）。 */
export function generateCheckMacValue(params: Params, hashKey: string, hashIv: string, algo: "sha256" | "md5" = "sha256"): string {
  const keys = Object.keys(params).filter((k) => k !== "CheckMacValue");
  keys.sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const raw = `HashKey=${hashKey}&${keys.map((k) => `${k}=${params[k]}`).join("&")}&HashIV=${hashIv}`;
  return createHash(algo).update(ecpayUrlEncode(raw), "utf8").digest("hex").toUpperCase();
}

/** timing-safe 驗章：所有收到的欄位（含 NeedExtraPaidInfo 額外欄位）都參與計算 */
export function verifyCheckMacValue(params: Params, hashKey: string, hashIv: string): boolean {
  const got = String(params.CheckMacValue || "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(got)) return false;
  const want = generateCheckMacValue(params, hashKey, hashIv, "sha256");
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** MerchantTradeNo：英數字、≤20 字（舊站 RY：截 18 字）。order 123 → "123TS" + 亂數 1 位 + 反轉 unix 秒 */
export function generateTradeNo(orderId: number, now: number = Date.now(), rand: number = Math.floor(Math.random() * 10)): string {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error("invalid order id");
  const t = String(Math.floor(now / 1000)).split("").reverse().join("");
  const no = `${orderId}TS${rand % 10}${t}`.slice(0, 18);
  if (!isValidTradeNo(no)) throw new Error("invalid trade no");
  return no;
}

export function isValidTradeNo(no: string): boolean {
  return /^[A-Za-z0-9]{1,20}$/.test(no);
}

/** 由 trade no 反推訂單 ID（只作交叉檢查；正式比對以資料庫 payment_attempts 為準） */
export function tradeNoToOrderId(no: string): number {
  const i = no.lastIndexOf("TS");
  return i > 0 ? Number(no.slice(0, i)) || 0 : 0;
}

/** MerchantTradeDate：UTC+8，yyyy/MM/dd HH:mm:ss */
export function taipeiDate(now: number = Date.now()): string {
  const d = new Date(now + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 舊站 RY get_item_name：去掉 ^'`!@＠#%&*+\"<>|_[] 等字元；另去控制字元與 HTML 標籤；截 195 字 */
export function sanitizeItemName(name: string): string {
  const s = String(name || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\^'`!@＠#%&*+\\"<>|_[\]]/g, "")
    .replace(/[;$]/g, "")
    .trim();
  return Array.from(s).slice(0, 195).join("") || "商品";
}

/** 舊站 RY：TradeDesc = 站名，ASCII 標點換空白，截 100 字 */
export function sanitizeTradeDesc(desc: string): string {
  const s = String(desc || "").replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return Array.from(s).slice(0, 100).join("") || "order";
}

/** 金額：TWD 正整數（舊站 RY：ceil(order total)） */
export function toTotalAmount(total: number | string): number {
  const n = Math.ceil(Number(total));
  if (!Number.isFinite(n) || n <= 0) throw new Error("invalid amount");
  return n;
}

export type CheckoutInput = {
  tradeNo: string;
  amount: number;
  itemName: string;
  tradeDesc: string;
  returnUrl: string; // Server 端通知（ReturnURL）
  orderResultUrl: string; // 付款完成後瀏覽器導回（僅顯示）
  clientBackUrl: string; // 「返回商店」按鈕（僅顯示）
  now?: number;
};

/** 組 AIO 信用卡一次付清的已簽章參數 */
export function buildCheckoutParams(cfg: EcpayConfig, i: CheckoutInput): Params {
  if (!isValidTradeNo(i.tradeNo)) throw new Error("invalid trade no");
  if (!Number.isSafeInteger(i.amount) || i.amount <= 0) throw new Error("invalid amount");
  const p: Params = {
    MerchantID: cfg.merchantId,
    MerchantTradeNo: i.tradeNo,
    MerchantTradeDate: taipeiDate(i.now),
    PaymentType: "aio",
    TotalAmount: String(i.amount),
    TradeDesc: sanitizeTradeDesc(i.tradeDesc),
    ItemName: sanitizeItemName(i.itemName),
    ReturnURL: i.returnUrl,
    OrderResultURL: i.orderResultUrl,
    ClientBackURL: i.clientBackUrl,
    ChoosePayment: "Credit",
    UnionPay: "2",
    IgnorePayment: "WeiXin#DigitalPayment#ApplePay",
    NeedExtraPaidInfo: "Y",
    EncryptType: "1",
  };
  p.CheckMacValue = generateCheckMacValue(p, cfg.hashKey, cfg.hashIv);
  return p;
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 自動送出到綠界的 HTML（與舊站相同：瀏覽器 POST 表單，不可用 iframe） */
export function autoSubmitHtml(cfg: EcpayConfig, params: Params): string {
  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escAttr(k)}" value="${escAttr(v)}">`)
    .join("");
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>前往綠界付款</title></head><body style="font-family:sans-serif;text-align:center;padding:48px 16px">
<p>正在前往綠界科技付款頁面，請稍候…</p>
<form id="ecpay" method="post" action="${escAttr(GATEWAY_URL[cfg.env])}" accept-charset="UTF-8">${inputs}<noscript><button type="submit">前往付款</button></noscript></form>
<script>document.getElementById("ecpay").submit();</script></body></html>`;
}

// ---------------- ReturnURL（Server 端通知）處理 ----------------

export type AttemptRow = { merchant_trade_no: string; order_id: number; amount: number };
export type ApplyInput = {
  tradeNo: string;
  amount: number;
  rtnCode: string;
  rtnMsg: string;
  ecpayTradeNo: string;
  paymentType: string;
  paymentDate: string;
  simulatePaid: boolean;
  countAsPaid: boolean; // production 下 SimulatePaid=1 不算付款
};
/** 資料庫端（Postgres 函式、交易內 FOR UPDATE）回傳的結果 */
export type ApplyResult = "paid" | "already_paid" | "duplicate_payment" | "failed" | "already_failed" | "failed_on_paid" | "simulated" | "amount_mismatch" | "unknown_trade_no";
export type NotifyStore = {
  findAttempt(tradeNo: string): Promise<AttemptRow | null>;
  apply(input: ApplyInput): Promise<ApplyResult>;
};
export type NotifyOutcome = { status: number; body: string; result: ApplyResult | "bad_signature" | "merchant_mismatch" | "bad_request" | "error" };

/**
 * 驗章 → 比對特店 → 比對 MerchantTradeNo 與金額 → 交給資料庫原子處理（冪等）。
 * 回應：成功處理（含重送、已付款）一律 HTTP 200 + `1|OK`；驗證失敗回 `0|...`（綠界會重送，但重送仍會被拒）。
 */
export async function processReturnNotification(params: Params, cfg: EcpayConfig, store: NotifyStore): Promise<NotifyOutcome> {
  if (!params || !params.MerchantTradeNo || !params.CheckMacValue) return { status: 400, body: "0|Bad Request", result: "bad_request" };
  if (!verifyCheckMacValue(params, cfg.hashKey, cfg.hashIv)) return { status: 400, body: "0|CheckMacValue Error", result: "bad_signature" };
  if (params.MerchantID !== cfg.merchantId) return { status: 400, body: "0|MerchantID Error", result: "merchant_mismatch" };
  const tradeNo = params.MerchantTradeNo;
  if (!isValidTradeNo(tradeNo)) return { status: 400, body: "0|MerchantTradeNo Error", result: "bad_request" };
  const amount = Number(params.TradeAmt);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { status: 400, body: "0|TradeAmt Error", result: "bad_request" };
  const attempt = await store.findAttempt(tradeNo);
  if (!attempt) return { status: 400, body: "0|Order Not Found", result: "unknown_trade_no" };
  if (attempt.amount !== amount) {
    // 交給資料庫寫入訂單備註與稽核紀錄（金額不符），但不改狀態
    await store.apply({ ...inputOf(params, cfg), amount });
    return { status: 400, body: "0|Amount Mismatch", result: "amount_mismatch" };
  }
  const result = await store.apply(inputOf(params, cfg));
  if (result === "amount_mismatch") return { status: 400, body: "0|Amount Mismatch", result };
  if (result === "unknown_trade_no") return { status: 400, body: "0|Order Not Found", result };
  return { status: 200, body: "1|OK", result };
}

function inputOf(params: Params, cfg: EcpayConfig): ApplyInput {
  const simulatePaid = String(params.SimulatePaid || "0") === "1";
  return {
    tradeNo: params.MerchantTradeNo,
    amount: Number(params.TradeAmt),
    rtnCode: String(params.RtnCode ?? ""),
    rtnMsg: String(params.RtnMsg ?? ""),
    ecpayTradeNo: String(params.TradeNo ?? ""),
    paymentType: String(params.PaymentType ?? ""),
    paymentDate: String(params.PaymentDate ?? ""),
    simulatePaid,
    countAsPaid: !(simulatePaid && cfg.env === "production"),
  };
}
