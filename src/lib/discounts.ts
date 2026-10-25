import type { DiscountRule, Site } from "./data";

/**
 * YITH Dynamic Pricing（ywdpd_discount）規則 —— 第三階段已從 WordPress DB 匯入（discount_rules.details_status = 'imported'）。
 *  - last_deals（加價購）：rules[0] = { product_id, discount_type: percentage|fixed|fixed_price, discount_amount, max_qty, title }
 *  - gift_products（贈品）：rules[0] = { gift_mode: cart_item|cart_subtotal, n_items: { condition, value }, subtotal,
 *      product_ids, amount_allowed, auto_add }
 *    · gift_mode = cart_item：購物車（非贈品）件數符合 n_items 條件即送。舊站訂單實證：「>」為嚴格大於
 *      （2 件以上的訂單都有贈品、1 件的訂單都沒有）。
 *    · gift_mode = cart_subtotal：購物車（非贈品）小計 ≥ subtotal 即可從 product_ids 選 amount_allowed 件。
 *    · auto_add = true → 自動放入購物車；否則在購物車／結帳頁跳出選擇贈品彈窗。
 *  - 停用（active = false）、未發布、排程外的規則一律不套用。
 * 在 DB 細節匯入前（details_status = 'pending_db'），只套用「舊站前台可觀察到」的加價購行為。
 */
export type LastDeal = {
  ruleId: number;
  title: string;
  productId: number;
  price: number;
  maxQty: number | null;
  inferred: boolean;
};

export type GiftRule = {
  ruleId: number;
  title: string;
  mode: "cart_item" | "cart_subtotal";
  nItems: { condition: string; value: number } | null;
  subtotal: number;
  productIds: number[];
  amountAllowed: number;
  autoAdd: boolean;
  modalText: string | null;
  priority: number;
};

const OBSERVED_LAST_DEALS: LastDeal[] = [
  { ruleId: 2603, title: "絕版兵士令，來一組！", productId: 2552, price: 1800, maxQty: null, inferred: true },
];

function live(r: DiscountRule, now = Date.now()) {
  if (r.status !== "publish" || r.active === false) return false;
  if (r.details_status === "imported" && r.active !== true) return false;
  if (r.schedule_from && Date.parse(r.schedule_from) > now) return false;
  if (r.schedule_to && Date.parse(r.schedule_to) < now) return false;
  return true;
}

const byPriority = (a: DiscountRule, b: DiscountRule) => (a.priority ?? 99) - (b.priority ?? 99) || a.id - b.id;

export function lastDeals(site: Site): LastDeal[] {
  const out: LastDeal[] = [];
  for (const r of [...site.rules].sort(byPriority)) {
    if (!live(r)) continue;
    const imported = parseLastDeal(site, r);
    if (imported) out.push(imported);
    else if (r.details_status !== "imported") {
      const o = OBSERVED_LAST_DEALS.find((x) => x.ruleId === r.id);
      if (o) out.push(o);
    }
  }
  return out;
}

function parseLastDeal(site: Site, r: DiscountRule): LastDeal | null {
  if (r.details_status !== "imported" || r.discount_mode !== "last_deals") return null;
  const rule = (r.rules as { product_id?: number; price?: number; title?: string; max_qty?: number | null; discount_type?: string; discount_amount?: number }[])[0];
  if (!rule?.product_id) return null;
  let price: number | null = rule.price !== undefined ? Number(rule.price) : null;
  if (price === null) {
    const p = site.products.find((x) => x.id === rule.product_id);
    const regular = Number(p?.price ?? NaN);
    if (!Number.isFinite(regular)) return null;
    const amt = Number(rule.discount_amount || 0);
    if (rule.discount_type === "percentage") price = Math.round(regular * (1 - amt / 100));
    else if (rule.discount_type === "price" || rule.discount_type === "fixed") price = Math.max(0, regular - amt);
    else if (rule.discount_type === "fixed_price") price = amt;
    else price = regular;
  }
  return { ruleId: r.id, title: rule.title || r.title, productId: rule.product_id, price, maxQty: rule.max_qty ?? null, inferred: false };
}

export function giftRules(site: Site): GiftRule[] {
  const out: GiftRule[] = [];
  for (const r of [...site.rules].sort(byPriority)) {
    if (!live(r) || r.details_status !== "imported" || r.discount_mode !== "gift_products") continue;
    const g = (r.rules as {
      gift_mode?: string;
      n_items?: { condition?: string; value?: number | null };
      subtotal?: number;
      product_ids?: number[];
      amount_allowed?: number;
      auto_add?: boolean;
      modal_text?: string | null;
    }[])[0];
    if (!g?.product_ids?.length) continue;
    out.push({
      ruleId: r.id,
      title: r.title,
      mode: g.gift_mode === "cart_subtotal" ? "cart_subtotal" : "cart_item",
      nItems: g.n_items?.value != null ? { condition: g.n_items.condition || ">", value: Number(g.n_items.value) } : null,
      subtotal: Number(g.subtotal || 0),
      productIds: g.product_ids,
      amountAllowed: Math.max(1, Number(g.amount_allowed || 1)),
      autoAdd: !!g.auto_add,
      modalText: g.modal_text || null,
      priority: r.priority ?? 99,
    });
  }
  return out;
}

function compare(n: number, cond: string, v: number) {
  switch (cond) {
    case ">":
      return n > v;
    case ">=":
      return n >= v;
    case "<":
      return n < v;
    case "<=":
      return n <= v;
    case "=":
    case "==":
      return n === v;
    default:
      return n > v;
  }
}

/** 贈品規則在目前購物車（只計非贈品品項）是否成立 */
export function giftEligible(g: GiftRule, itemCount: number, subtotal: number) {
  if (itemCount <= 0) return false;
  if (g.mode === "cart_subtotal") return subtotal >= g.subtotal;
  return g.nItems ? compare(itemCount, g.nItems.condition, g.nItems.value) : true;
}
