import { autoSubmitHtml, startPayment } from "@/lib/ecpay";

export const dynamic = "force-dynamic";

function page(msg: string, back: string | null, status = 400) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return new Response(
    `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>付款</title></head><body style="font-family:sans-serif;text-align:center;padding:48px 16px"><p>${esc(msg)}</p>${back ? `<p><a href="${esc(back)}">返回訂單</a></p>` : `<p><a href="/">回首頁</a></p>`}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } },
  );
}

/** 產生綠界付款表單（每次產生新的 MerchantTradeNo）並自動送出 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = Number(u.searchParams.get("id"));
  const key = u.searchParams.get("key") || "";
  if (!Number.isSafeInteger(id) || id <= 0 || !key) return page("找不到訂單。", null, 404);
  const back = `/checkout-2/order-received/${id}/?key=${encodeURIComponent(key)}`;
  let r;
  try {
    r = await startPayment(id, key);
  } catch {
    return page("建立付款失敗，請稍後再試。", back, 500);
  }
  if (!r.ok) return page(r.message, r.message === "找不到訂單。" ? null : back);
  return new Response(autoSubmitHtml(r.cfg, r.params), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
