import { dbNotifyStore, ecpayBlockReason, ecpayRawConfig, processReturnNotification } from "@/lib/ecpay";

export const dynamic = "force-dynamic";

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** 綠界 ReturnURL（Server 端付款通知）：驗章、比對交易與金額、冪等更新訂單，成功回 1|OK */
export async function POST(req: Request) {
  const cfg = ecpayRawConfig();
  if (!cfg) return text("0|ECPay Disabled", 503);
  let params: Record<string, string> = {};
  try {
    const fd = await req.formData();
    for (const [k, v] of fd.entries()) if (typeof v === "string") params[k] = v;
  } catch {
    params = {};
  }
  try {
    // 防呆：測試環境／測試特店金鑰 + 正式網域 → 仍驗章並記錄，但一律不標記已付款（訂單備註＋稽核紀錄警示）
    const blockReason = ecpayBlockReason(cfg);
    const out = await processReturnNotification(params, cfg, dbNotifyStore, { blockReason });
    if (out.result === "blocked_test_env") console.error("[ecpay notify] 拒絕標記已付款（測試金鑰用於正式網域）", params.MerchantTradeNo || "", blockReason);
    if (out.status !== 200) console.warn("[ecpay notify] rejected", out.result, params.MerchantTradeNo || "");
    return text(out.body, out.status);
  } catch (e) {
    console.error("[ecpay notify] error", params.MerchantTradeNo || "", e instanceof Error ? e.message : e);
    return text("0|Error", 500);
  }
}
