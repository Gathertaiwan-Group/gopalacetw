import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSite } from "@/lib/data";
import { liveMaxQty, loadCart, MAX_QTY_PER_ITEM, readCartToken, shippingFor } from "@/lib/cart";
import { serviceDb } from "@/lib/supabase";
import { formBody, logSubmission } from "@/lib/forms";
import { currentUser, customerFor } from "@/lib/auth";
import { twZipcode } from "@/theme/twzip";
import { expireHoldsInRoute, HOLD_MINUTES, MAX_UNPAID_PER_EMAIL, MAX_UNPAID_PER_IP, paymentMethod, payUrl } from "@/lib/ecpay";

export const dynamic = "force-dynamic";

const REQUIRED_BILLING: [string, string][] = [
  ["billing_first_name", "帳單 名字"],
  ["billing_last_name", "帳單 姓氏"],
  ["billing_address_1", "帳單 街道地址"],
  ["billing_city", "帳單 鄉鎮市"],
  ["billing_state", "帳單 縣 / 市"],
  ["billing_postcode", "帳單 郵遞區號"],
  ["billing_phone", "帳單 聯絡電話"],
  ["billing_email", "帳單 電子郵件地址"],
];
const REQUIRED_SHIPPING: [string, string][] = [
  ["shipping_first_name", "運送 名字"],
  ["shipping_last_name", "運送 姓氏"],
  ["shipping_address_1", "運送 街道地址"],
  ["shipping_city", "運送 鄉鎮市"],
  ["shipping_state", "運送 縣 / 市"],
  ["shipping_postcode", "運送 郵遞區號"],
  ["shipping_phone", "運送 行動電話"],
];

function fail(req: Request, json: boolean, msg: string) {
  if (json) return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  return NextResponse.redirect(new URL(`/checkout-2/?error=${encodeURIComponent(msg)}`, req.url), 303);
}

export async function POST(req: Request) {
  const json = (req.headers.get("accept") || "").includes("application/json");
  const f = await formBody(req);
  // 台灣地址：縣市下拉 → billing_state
  if (!f.billing_state && f.billing_county) f.billing_state = f.billing_county;
  if (!f.shipping_state && f.shipping_county) f.shipping_state = f.shipping_county;
  // 鄉鎮市區下拉 → *_city；郵遞區號由縣市＋鄉鎮市區自動帶入（對應舊站 woomp twzipcode）
  for (const p of ["billing", "shipping"] as const) {
    if (!f[`${p}_city`] && f[`${p}_district`]) f[`${p}_city`] = f[`${p}_district`];
    if (!f[`${p}_postcode`] && f[`${p}_zipcode`]) f[`${p}_postcode`] = f[`${p}_zipcode`];
    const z = twZipcode(f[`${p}_state`], f[`${p}_city`]);
    if (z && !f[`${p}_postcode`]) f[`${p}_postcode`] = z;
  }
  const diff = f.ship_to_different_address === "1";
  const missing = [...REQUIRED_BILLING, ...(diff ? REQUIRED_SHIPPING : [])].filter(([k]) => !String(f[k] || "").trim()).map(([, l]) => `${l} 是必填欄位。`);
  if (missing.length) return fail(req, json, missing.join(" "));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.billing_email)) return fail(req, json, "帳單 電子郵件地址 格式不正確。");
  if (!/^[0-9+\-\s()#]{6,20}$/.test(f.billing_phone)) return fail(req, json, "帳單 聯絡電話 格式不正確。");

  const site = await getSite();
  const token = await readCartToken();
  const cart = await loadCart(token, site);
  if (!cart.lines.length) return fail(req, json, "你的購物車是空的。");
  // 先取消逾期未付款訂單、釋放其保留庫存，再以即時庫存檢查（快取的商品資料可能落後 5 分鐘）。
  // 最終判斷在資料庫 checkout_place_hold（鎖列、原子預留、單品數量上限）。
  await expireHoldsInRoute();
  const perItem = new Map<string, { line: (typeof cart.lines)[number]; qty: number }>();
  for (const l of cart.lines) {
    const k = `${l.product.id}:${l.variation_id ?? ""}`;
    const cur = perItem.get(k);
    perItem.set(k, { line: l, qty: (cur?.qty || 0) + l.quantity });
  }
  for (const { line: l, qty } of perItem.values()) {
    const live = await liveMaxQty(l.product, l.variation_id);
    if (live.outOfStock) return fail(req, json, `「${l.product.name}」已售完。`);
    if (qty > live.max) return fail(req, json, qty > MAX_QTY_PER_ITEM ? `「${l.product.name}」每筆訂單最多 ${MAX_QTY_PER_ITEM} 件。` : `「${l.product.name}」庫存不足。`);
  }

  const db = serviceDb();
  const user = await currentUser();
  const customer = user ? await customerFor(user) : null;
  const sh = shippingFor(site, cart.subtotal);
  const pay = paymentMethod(site);
  const s = (k: string) => (diff ? f[`shipping_${k}`] : f[`billing_${k}`]) || null;
  const orderKey = "wc_order_" + randomBytes(9).toString("base64url");
  const attribution: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith("wc_order_attribution_")) attribution[k.replace("wc_order_attribution_", "")] = v;

  const { data: order, error } = await db
    .from("orders")
    .insert({
      order_key: orderKey,
      status: "pending",
      currency: "TWD",
      customer_id: customer?.id ?? null,
      customer_ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null,
      customer_user_agent: req.headers.get("user-agent"),
      billing_first_name: f.billing_first_name,
      billing_last_name: f.billing_last_name,
      billing_company: f.billing_company || null,
      billing_address_1: f.billing_address_1,
      billing_address_2: f.billing_address_2 || null,
      billing_city: f.billing_city,
      billing_state: f.billing_state,
      billing_postcode: f.billing_postcode,
      billing_country: "TW",
      billing_email: f.billing_email.trim().toLowerCase(),
      billing_phone: f.billing_phone,
      shipping_first_name: s("first_name"),
      shipping_last_name: s("last_name"),
      shipping_company: s("company"),
      shipping_address_1: s("address_1"),
      shipping_address_2: s("address_2"),
      shipping_city: s("city"),
      shipping_state: s("state"),
      shipping_postcode: s("postcode"),
      shipping_country: "TW",
      shipping_phone: diff ? f.shipping_phone : f.billing_phone,
      payment_method: pay.id,
      payment_method_title: pay.title,
      shipping_method: sh.id,
      shipping_method_title: sh.title,
      subtotal: cart.subtotal,
      discount_total: cart.discount,
      shipping_total: cart.shipping,
      total: cart.total,
      customer_note: f.order_comments || null,
      created_via: "checkout",
      attribution,
      meta: {
        tw_address: { billing: { county: f.billing_state, district: f.billing_city, zipcode: f.billing_postcode }, shipping: diff ? { county: f.shipping_state, district: f.shipping_city, zipcode: f.shipping_postcode } : null },
        real_payment: pay.ecpay,
        ...(pay.ecpay ? {} : { note: "新站未串接金流：建立待付款訂單" }),
      },
    })
    .select("id,order_key")
    .single();
  if (error || !order) return fail(req, json, "建立訂單失敗，請稍後再試。");
  await db.from("orders").update({ order_number: String(order.id) }).eq("id", order.id);

  const items = cart.lines.map((l) => ({
    order_id: order.id,
    item_type: "line_item",
    name: l.product.raw_name ?? l.product.name, // WooCommerce 訂單明細存原始商品名稱
    product_id: l.product.id,
    variation_id: l.variation_id,
    sku: l.product.sku,
    quantity: l.quantity,
    unit_price: l.unit_price,
    subtotal: l.line_total,
    total: l.line_total,
    meta: (l.discount_rule_id ? { discount_rule_id: l.discount_rule_id, regular_price: Number(l.product.price), ...(l.is_gift ? { is_gift: true } : {}) } : {}) as Record<string, unknown>,
  }));
  items.push({
    order_id: order.id,
    item_type: "shipping",
    name: sh.title,
    product_id: null as unknown as number,
    variation_id: null,
    sku: null,
    quantity: 1,
    unit_price: cart.shipping,
    subtotal: cart.shipping,
    total: cart.shipping,
    meta: { method_id: sh.id },
  });
  for (const c of cart.coupons)
    items.push({ order_id: order.id, item_type: "coupon", name: c.code, product_id: null as unknown as number, variation_id: null, sku: null, quantity: 1, unit_price: -c.amount, subtotal: -c.amount, total: -c.amount, meta: { coupon_id: c.id, discount: c.amount } });
  const { error: itemErr } = await db.from("order_items").insert(items);
  if (itemErr) {
    await db.from("orders").delete().eq("id", order.id);
    return fail(req, json, "建立訂單失敗，請稍後再試。");
  }
  // 資料庫交易內：鎖住庫存列原子地預留（綠界訂單保留 HOLD_MINUTES 分鐘；不足即拒絕）、計入優惠券使用次數、灌單上限
  const { data: held, error: holdErr } = await db.rpc("checkout_place_hold", {
    p_order_id: order.id,
    p_hold: pay.ecpay,
    p_hold_minutes: HOLD_MINUTES,
    p_max_unpaid_per_email: MAX_UNPAID_PER_EMAIL,
    p_max_unpaid_per_ip: MAX_UNPAID_PER_IP,
    p_max_qty_per_item: MAX_QTY_PER_ITEM,
  });
  const hr = String(held ?? "");
  if (holdErr || hr !== "ok") {
    // 呼叫錯誤時無法確定是否已預留：先取消（觸發器會釋放預留、回補優惠券）再刪除
    if (holdErr) await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    await db.from("orders").delete().eq("id", order.id);
    if (hr.startsWith("out_of_stock:")) return fail(req, json, `「${hr.slice(13)}」庫存不足。`);
    if (hr.startsWith("qty_limit:")) return fail(req, json, `「${hr.slice(10)}」每筆訂單最多 ${MAX_QTY_PER_ITEM} 件。`);
    if (hr.startsWith("coupon_limit:")) return fail(req, json, `優惠券「${hr.slice(13)}」已達使用次數上限。`);
    if (hr === "too_many_unpaid") return fail(req, json, "你有多筆尚未付款的訂單，請先完成付款或稍後再試。");
    return fail(req, json, "建立訂單失敗，請稍後再試。");
  }
  await db.from("order_notes").insert({ order_id: order.id, note: pay.ecpay ? "訂單狀態：待付款（等待綠界信用卡付款）" : "訂單狀態：待付款（新站結帳，未串接金流）", is_customer_note: false, added_by: "system" });
  if (customer?.id && !Object.keys((customer.billing as object) || {}).length) {
    const billing = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith("billing_")).map(([k, v]) => [k.replace("billing_", ""), v]));
    await db.from("customers").update({ billing }).eq("id", customer.id);
  }
  if (cart.id) {
    await db.from("cart_items").delete().eq("cart_id", cart.id);
    await db.from("carts").update({ coupon_codes: [] }).eq("id", cart.id);
  }
  await logSubmission("checkout", { ...f, order_id: order.id }, req, "converted");

  // 綠界啟用：導向付款（自動送出表單到綠界）；未啟用：訂單完成頁
  const dest = pay.ecpay ? payUrl(order.id, order.order_key) : `/checkout-2/order-received/${order.id}/?key=${order.order_key}`;
  if (json) return NextResponse.json({ ok: true, order_id: order.id, redirect: dest });
  return NextResponse.redirect(new URL(dest, req.url), 303);
}
