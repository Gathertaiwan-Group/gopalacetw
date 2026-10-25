import { NextResponse } from "next/server";
import { getSite } from "@/lib/data";
import { CART_COOKIE, CART_MARK_COOKIE, couponError, ensureCart, findCoupon, loadCart, maxQty, readCartToken } from "@/lib/cart";
import { serviceDb } from "@/lib/supabase";
import { lastDeals } from "@/lib/discounts";
import { formBody, logSubmission } from "@/lib/forms";
import { miniCartHtml } from "@/theme/shop";
import { priceHtml } from "@/theme/util";
import { responsiveHtml } from "@/lib/images";

export const dynamic = "force-dynamic";

async function state(token: string | null) {
  const site = await getSite();
  const cart = await loadCart(token, site);
  return { count: cart.count, subtotal: cart.subtotal, amount_html: priceHtml(cart.subtotal), mini_html: responsiveHtml(site, miniCartHtml(cart)), total: cart.total };
}

async function act(a: Record<string, string>, req: Request) {
  const site = await getSite();
  const db = serviceDb();
  let token = await readCartToken();
  const action = a.action || "add";
  let message = "";
  if (action === "add" || action === "deal") {
    const pid = Number(a.product_id || a["add-to-cart"]);
    const p = site.products.find((x) => x.id === pid && x.status === "publish");
    if (!p || p.price === null || p.price === "") return { error: "此商品無法購買。" };
    if (p.stock_status === "outofstock") return { error: `「${p.name}」已售完，無法加入購物車。` };
    let ruleId: number | null = null;
    let unit = Number(p.price);
    if (action === "deal") {
      const d = lastDeals(site).find((x) => x.ruleId === Number(a.rule) && x.productId === pid);
      if (!d) return { error: "優惠已失效。" };
      ruleId = d.ruleId;
      unit = d.price;
    }
    const variationId = a.variation_id && Number(a.variation_id) > 0 ? Number(a.variation_id) : null;
    if (p.type === "variable" && !variationId) return { error: "請選擇商品選項。" };
    const qty = Math.max(1, Math.floor(Number(a.quantity || 1)));
    const cart = await ensureCart(token);
    token = cart.token;
    let q = db.from("cart_items").select("id,quantity").eq("cart_id", cart.id).eq("product_id", pid);
    q = ruleId === null ? q.is("discount_rule_id", null) : q.eq("discount_rule_id", ruleId);
    q = variationId === null ? q.is("variation_id", null) : q.eq("variation_id", variationId);
    const { data: existing } = await q.maybeSingle();
    const max = maxQty(p);
    const newQty = (existing?.quantity || 0) + qty;
    if (max !== null && newQty > max) return { error: `「${p.name}」庫存不足（最多 ${max} 件）。`, token };
    if (existing) await db.from("cart_items").update({ quantity: newQty, unit_price: unit }).eq("id", existing.id);
    else await db.from("cart_items").insert({ cart_id: cart.id, product_id: pid, variation_id: variationId, quantity: qty, unit_price: unit, discount_rule_id: ruleId });
    await db.from("carts").update({ updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }).eq("id", cart.id);
    await logSubmission("add-to-cart", { product_id: pid, quantity: qty, rule: ruleId }, req);
    message = `「${p.name}」已加入你的購物車。`;
  } else if (action === "coupon" || action === "remove_coupon") {
    const code = String(a.code || "").trim();
    if (!code) return { error: "請輸入優惠券代碼。" };
    if (!token) return { error: "購物車是空的。" };
    const { data: c } = await db.from("carts").select("id,coupon_codes").eq("token", token).maybeSingle();
    if (!c) return { error: "購物車是空的。" };
    const codes = ((c.coupon_codes as string[]) || []).filter((x) => x.toLowerCase() !== code.toLowerCase());
    if (action === "coupon") {
      const cart = await loadCart(token, site);
      const coupon = await findCoupon(code);
      const err = couponError(coupon, code, cart.subtotal);
      if (err) return { error: err, token };
      codes.push(coupon!.code);
      message = "已成功套用優惠券。";
    } else message = "已移除優惠券。";
    await db.from("carts").update({ coupon_codes: codes }).eq("id", c.id);
  } else if (action === "update" || action === "remove") {
    if (!token) return { error: "購物車是空的。" };
    const { data: c } = await db.from("carts").select("id").eq("token", token).maybeSingle();
    if (!c) return { error: "購物車是空的。" };
    const line = Number(a.line);
    const qty = action === "remove" ? 0 : Math.max(0, Math.floor(Number(a.quantity)));
    if (qty === 0) await db.from("cart_items").delete().eq("id", line).eq("cart_id", c.id);
    else {
      const { data: row } = await db.from("cart_items").select("product_id").eq("id", line).eq("cart_id", c.id).maybeSingle();
      const p = row && site.products.find((x) => x.id === row.product_id);
      const max = p ? maxQty(p) : null;
      if (max !== null && qty > max) return { error: `庫存不足（最多 ${max} 件）。`, token };
      await db.from("cart_items").update({ quantity: qty }).eq("id", line).eq("cart_id", c.id);
    }
    message = action === "remove" ? "已移除商品。" : "購物車已更新。";
  }
  return { token, message };
}

function setCookie(res: NextResponse, token: string | null | undefined) {
  if (token) {
    res.cookies.set(CART_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 30 * 86400 });
    // 非 HttpOnly 標記：公開頁為 ISR 快取（頁首購物車固定為空），前台 JS 見到此標記才向 /api/cart/ 取回實際數量
    res.cookies.set(CART_MARK_COOKIE, "1", { httpOnly: false, sameSite: "lax", secure: true, path: "/", maxAge: 30 * 86400 });
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const a = Object.fromEntries(u.searchParams.entries());
  if (!a.action) return NextResponse.json(await state(await readCartToken()));
  const r = await act(a, req);
  const back = a.back && a.back.startsWith("/") ? a.back : "/cart-2/";
  const dest = new URL(a.action === "add" && !r.error ? "/cart-2/" : back, req.url);
  const res = NextResponse.redirect(dest, 302);
  setCookie(res, r.token);
  return res;
}

export async function POST(req: Request) {
  const a = await formBody(req);
  const r = await act(a, req);
  const res = NextResponse.json({ ok: !r.error, error: r.error, message: r.message, ...(await state(r.token ?? (await readCartToken()))) }, { status: r.error ? 400 : 200 });
  setCookie(res, r.token);
  return res;
}
