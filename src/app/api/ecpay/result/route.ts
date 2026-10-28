import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * 綠界 OrderResultURL（付款後瀏覽器導回）：只負責導向訂單完成頁顯示，不改訂單狀態。
 * 訂單狀態只由 ReturnURL（/api/ecpay/notify/）在驗章後更新。
 */
function go(req: Request) {
  const u = new URL(req.url);
  const id = Number(u.searchParams.get("id"));
  const key = u.searchParams.get("key") || "";
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[A-Za-z0-9_\-]{1,64}$/.test(key)) return NextResponse.redirect(new URL("/", req.url), 303);
  return NextResponse.redirect(new URL(`/checkout-2/order-received/${id}/?key=${encodeURIComponent(key)}`, req.url), 303);
}

export const POST = go;
export const GET = go;
