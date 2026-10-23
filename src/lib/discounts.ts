import type { DiscountRule, Site } from "./data";

/**
 * YITH Dynamic Pricing 規則。
 * 規則細節（條件、贈品、加價購價）不在公開 REST；第三階段匯入 DB 後以 discount_rules.rules 為準。
 * 在 DB 細節尚未匯入（details_status = 'pending_db'）前，只套用「舊站前台可觀察到」的行為：
 *  - 2603「購物車加價購兵士令」：結帳頁彈窗「絕版兵士令，來一組！」，兵士令(不含杯子) #2552 NT$2,000 → NT$1,800（快照 html/checkout-2__with-item.html）
 * 2600「下單就送非我莫鼠」、2605「滿10000送公仔杯一組」的贈品條件無法從前台確認，待 DB。
 */
export type LastDeal = {
  ruleId: number;
  title: string;
  productId: number;
  price: number;
  maxQty: number | null;
  inferred: boolean;
};

const OBSERVED_LAST_DEALS: LastDeal[] = [
  { ruleId: 2603, title: "絕版兵士令，來一組！", productId: 2552, price: 1800, maxQty: null, inferred: true },
];

export function lastDeals(site: Site): LastDeal[] {
  const out: LastDeal[] = [];
  for (const r of site.rules) {
    if (r.status !== "publish" || r.active === false) continue;
    const imported = parseLastDeal(r);
    if (imported) out.push(imported);
    else if (r.details_status !== "imported") {
      const o = OBSERVED_LAST_DEALS.find((x) => x.ruleId === r.id);
      if (o) out.push(o);
    }
  }
  return out;
}

function parseLastDeal(r: DiscountRule): LastDeal | null {
  if (r.details_status !== "imported" || r.discount_mode !== "last_deals") return null;
  const rule = (r.rules as { product_id?: number; price?: number; title?: string; max_qty?: number }[])[0];
  if (!rule?.product_id || rule.price === undefined) return null;
  return { ruleId: r.id, title: rule.title || r.title, productId: rule.product_id, price: Number(rule.price), maxQty: rule.max_qty ?? null, inferred: false };
}
