import "server-only";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { serviceDb } from "./supabase";
import { getSite, type Product, type Site } from "./data";
import { giftEligible, giftRules, lastDeals } from "./discounts";

export const CART_COOKIE = "gp_cart";
export const CART_MARK_COOKIE = "gp_cart_mark";

export type CartLine = {
  id: number;
  product: Product;
  variation_id: number | null;
  quantity: number;
  unit_price: number;
  line_total: number;
  is_gift: boolean;
  discount_rule_id: number | null;
};

export type AppliedCoupon = { id: number; code: string; amount: number; free_shipping: boolean };

export type Cart = {
  id: string | null;
  token: string | null;
  lines: CartLine[];
  count: number;
  subtotal: number;
  discount: number;
  coupons: AppliedCoupon[];
  shipping: number;
  shippingLabel: string;
  total: number;
};

export function shippingFor(site: Site, subtotal: number) {
  const s = site.settings.shipping || {};
  const method = (s.methods || [])[0] || { id: "flat_rate:1", cost: 150, title: "宅配到家(滿6000免運）" };
  const freeMin = Number(s.free_shipping_min_amount ?? 6000);
  const cost = subtotal >= freeMin ? 0 : Number(method.cost ?? 150);
  return { id: String(method.id), title: String(method.title), cost };
}

export function emptyCart(site: Site): Cart {
  const sh = shippingFor(site, 0);
  return { id: null, token: null, lines: [], count: 0, subtotal: 0, discount: 0, coupons: [], shipping: sh.cost, shippingLabel: sh.title, total: 0 };
}

export async function readCartToken(): Promise<string | null> {
  const c = await cookies();
  const t = c.get(CART_COOKIE)?.value;
  return t && /^[a-f0-9]{48}$/.test(t) ? t : null;
}

export async function loadCart(token: string | null, site?: Site): Promise<Cart> {
  site = site || (await getSite());
  if (!token) return emptyCart(site);
  const db = serviceDb();
  const { data: cart } = await db.from("carts").select("id,token,expires_at,coupon_codes").eq("token", token).maybeSingle();
  if (!cart || new Date(cart.expires_at) < new Date()) return emptyCart(site);
  const { data: rows } = await db
    .from("cart_items")
    .select("id,product_id,variation_id,quantity,unit_price,is_gift,discount_rule_id")
    .eq("cart_id", cart.id)
    .order("id");
  const lines: CartLine[] = [];
  const chosenGifts: NonNullable<typeof rows> = [];
  for (const r of rows || []) {
    const product = site.products.find((p) => p.id === r.product_id);
    if (!product || product.status !== "publish") continue;
    if (r.is_gift) {
      chosenGifts.push(r);
      continue;
    }
    const variation = r.variation_id ? site.variations.find((v) => v.id === r.variation_id) : null;
    // 價格以目前商品資料為準（加價購規則價除外）
    let unit = Number(variation?.price ?? product.price ?? 0);
    if (r.discount_rule_id) {
      const deal = lastDeals(site).find((d) => d.ruleId === r.discount_rule_id && d.productId === product.id);
      unit = deal ? deal.price : unit;
    }
    lines.push({
      id: r.id,
      product,
      variation_id: r.variation_id,
      quantity: r.quantity,
      unit_price: unit,
      line_total: unit * r.quantity,
      is_gift: r.is_gift,
      discount_rule_id: r.discount_rule_id,
    });
  }
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  lines.push(...giftLines(site, lines, subtotal, chosenGifts));
  const coupons = await applyCoupons((cart.coupon_codes as string[]) || [], lines, subtotal);
  const discount = Math.min(subtotal, coupons.reduce((s, c) => s + c.amount, 0));
  const sh = shippingFor(site, subtotal);
  const shipping = lines.length && !coupons.some((c) => c.free_shipping) ? sh.cost : 0;
  return {
    id: cart.id,
    token,
    lines,
    count: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal,
    discount,
    coupons,
    shipping,
    shippingLabel: sh.title,
    total: subtotal - discount + shipping,
  };
}

/**
 * YITH 贈品（gift_products）：只依非贈品品項判斷條件。
 * 自動贈品以虛擬品項（id = -規則ID）呈現，不寫入 cart_items；需顧客挑選的贈品存在 cart_items（is_gift = true），
 * 條件不再成立時不列入購物車與訂單。
 */
function giftLines(
  site: Site,
  paid: CartLine[],
  subtotal: number,
  chosen: { id: number; product_id: number; variation_id: number | null; quantity: number; discount_rule_id: number | null }[],
): CartLine[] {
  const count = paid.reduce((s, l) => s + l.quantity, 0);
  const out: CartLine[] = [];
  for (const g of giftRules(site)) {
    if (!giftEligible(g, count, subtotal)) continue;
    if (g.autoAdd) {
      let left = g.amountAllowed;
      for (const pid of g.productIds) {
        if (left <= 0) break;
        const product = site.products.find((p) => p.id === pid && p.status === "publish");
        if (!product || product.stock_status === "outofstock") continue;
        out.push({ id: -g.ruleId, product, variation_id: null, quantity: 1, unit_price: 0, line_total: 0, is_gift: true, discount_rule_id: g.ruleId });
        left--;
      }
    } else {
      let left = g.amountAllowed;
      for (const r of chosen.filter((c) => c.discount_rule_id === g.ruleId && g.productIds.includes(c.product_id))) {
        if (left <= 0) break;
        const product = site.products.find((p) => p.id === r.product_id && p.status === "publish");
        if (!product) continue;
        const q = Math.min(r.quantity, left);
        left -= q;
        out.push({ id: r.id, product, variation_id: r.variation_id, quantity: q, unit_price: 0, line_total: 0, is_gift: true, discount_rule_id: g.ruleId });
      }
    }
  }
  return out;
}

/** 可挑選但尚未選滿的贈品規則（給購物車／結帳頁彈窗） */
export function pendingGiftChoice(site: Site, cart: Cart) {
  const paid = cart.lines.filter((l) => !l.is_gift);
  const count = paid.reduce((s, l) => s + l.quantity, 0);
  for (const g of giftRules(site)) {
    if (g.autoAdd || !giftEligible(g, count, cart.subtotal)) continue;
    const taken = cart.lines.filter((l) => l.is_gift && l.discount_rule_id === g.ruleId).reduce((s, l) => s + l.quantity, 0);
    if (taken >= g.amountAllowed) continue;
    const products = g.productIds
      .map((id) => site.products.find((p) => p.id === id && p.status === "publish" && p.stock_status !== "outofstock"))
      .filter((p): p is Product => !!p);
    if (products.length) return { rule: g, products, left: g.amountAllowed - taken };
  }
  return null;
}

export async function currentCart(site?: Site) {
  return loadCart(await readCartToken(), site);
}

export function newToken() {
  return randomBytes(24).toString("hex");
}

export async function ensureCart(token: string | null): Promise<{ id: string; token: string; created: boolean }> {
  const db = serviceDb();
  if (token) {
    const { data } = await db.from("carts").select("id,token,expires_at").eq("token", token).maybeSingle();
    if (data && new Date(data.expires_at) > new Date()) return { id: data.id, token, created: false };
  }
  const t = newToken();
  const { data, error } = await db.from("carts").insert({ token: t }).select("id").single();
  if (error || !data) throw new Error(error?.message || "無法建立購物車");
  return { id: data.id, token: t, created: true };
}

export function maxQty(p: Product): number | null {
  if (p.sold_individually) return 1;
  if (p.manage_stock && p.stock_quantity !== null && p.backorders === "no") return Math.max(0, p.stock_quantity);
  return p.purchase_max ?? null;
}

type CouponRow = {
  id: number;
  code: string;
  status: string;
  discount_type: "percent" | "fixed_cart" | "fixed_product";
  amount: string;
  date_expires: string | null;
  usage_count: number;
  usage_limit: number | null;
  free_shipping: boolean;
  exclude_sale_items: boolean;
  product_ids: number[];
  excluded_product_ids: number[];
  product_categories: number[];
  excluded_product_categories: number[];
  minimum_amount: string | null;
  maximum_amount: string | null;
};

/** 檢查優惠券是否可用；回傳錯誤訊息或 null（WooCommerce 規則子集） */
export function couponError(c: CouponRow | null, code: string, subtotal: number): string | null {
  if (!c || c.status !== "publish") return `優惠券「${code}」不存在！`;
  if (c.date_expires && new Date(c.date_expires) < new Date()) return "此優惠券已過期。";
  if (c.usage_limit !== null && c.usage_count >= c.usage_limit) return "此優惠券的使用次數已達上限。";
  if (c.minimum_amount !== null && subtotal < Number(c.minimum_amount)) return `此優惠券的最低消費金額為 NT$${Number(c.minimum_amount).toLocaleString("en-US")}。`;
  if (c.maximum_amount !== null && Number(c.maximum_amount) > 0 && subtotal > Number(c.maximum_amount)) return `此優惠券的最高消費金額為 NT$${Number(c.maximum_amount).toLocaleString("en-US")}。`;
  return null;
}

export async function findCoupon(code: string): Promise<CouponRow | null> {
  const db = serviceDb();
  const { data } = await db.from("coupons").select("*").ilike("code", code.replace(/[\\%_]/g, (m) => "\\" + m)).maybeSingle();
  return (data as CouponRow) || null;
}

async function applyCoupons(codes: string[], lines: CartLine[], subtotal: number): Promise<AppliedCoupon[]> {
  const out: AppliedCoupon[] = [];
  for (const code of codes) {
    const c = await findCoupon(code);
    if (!c || couponError(c, code, subtotal)) continue;
    const eligible = lines.filter((l) => {
      const cats = l.product.terms.map((t) => t.id);
      if (c.product_ids.length && !c.product_ids.includes(l.product.id)) return false;
      if (c.excluded_product_ids.includes(l.product.id)) return false;
      if (c.product_categories.length && !cats.some((x) => c.product_categories.includes(x))) return false;
      if (c.excluded_product_categories.some((x) => cats.includes(x))) return false;
      if (c.exclude_sale_items && l.product.on_sale) return false;
      return true;
    });
    const base = eligible.reduce((s, l) => s + l.line_total, 0);
    const amt = Number(c.amount);
    let amount = 0;
    if (c.discount_type === "percent") amount = Math.round((base * amt) / 100);
    else if (c.discount_type === "fixed_cart") amount = Math.min(base, amt);
    else amount = eligible.reduce((s, l) => s + Math.min(l.line_total, amt * l.quantity), 0);
    out.push({ id: c.id, code: c.code, amount, free_shipping: c.free_shipping });
  }
  return out;
}
