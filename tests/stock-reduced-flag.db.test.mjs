// 資料庫整合測試（2026-10-29 最終複驗 Medium）：庫存扣減改看 order_stock_reduced，不看舊狀態。
//   cancelled→on-hold→processing、refunded→processing、failed→on-hold 會補扣一次；processing→completed 不重複扣；
//   cancelled/failed 歸還一次；已付款改已退款不自動回補；人工付款單確認時扣一次；搬遷舊單（無預留紀錄）取消時依明細歸還。
// 需要 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（未提供則略過）。測試資料使用固定 id（99000xxx），結束時刪除，
// 並比對測試前後：既有商品／規格庫存、優惠券、以及訂單／商品／優惠券／明細的筆數與最大 id。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SKIP = { skip: !URL_ || !KEY ? "未提供 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" : false };
const db = URL_ && KEY ? createClient(URL_, KEY, { db: { schema: "site_gopalacetw" }, auth: { persistSession: false } }) : null;

const BASE = 99000100; // 固定 id 區段：商品 / 優惠券 / 訂單 / 明細 皆用 BASE+n
const PRODUCT_IDS = Array.from({ length: 10 }, (_, i) => BASE + i);
const COUPON_ID = BASE;
const ORDER_IDS = Array.from({ length: 20 }, (_, i) => BASE + i);
const ITEM_IDS = Array.from({ length: 40 }, (_, i) => BASE + i);
let snap = null;

const must = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
async function stats(table) {
  const { count } = await db.from(table).select("id", { count: "exact", head: true });
  const top = must(await db.from(table).select("id").order("id", { ascending: false }).limit(1));
  return { count, max: top[0]?.id ?? null };
}
async function snapshot() {
  return {
    products: must(await db.from("products").select("id,stock_quantity,stock_status").order("id")),
    variations: must(await db.from("product_variations").select("id,stock_quantity,stock_status").order("id")),
    coupons: must(await db.from("coupons").select("id,usage_count,used_by").order("id")),
    tables: {
      orders: await stats("orders"),
      products: await stats("products"),
      coupons: await stats("coupons"),
      order_items: await stats("order_items"),
    },
  };
}
async function cleanup() {
  await db.from("audit_log").delete().eq("entity_type", "order").in("entity_id", ORDER_IDS.map(String));
  await db.from("orders").delete().in("id", ORDER_IDS);
  await db.from("products").delete().in("id", PRODUCT_IDS);
  await db.from("coupons").delete().eq("id", COUPON_ID);
}

before(async () => {
  if (!db) return;
  await cleanup(); // 上次中斷留下的固定 id 測試列
  snap = await snapshot();
});

after(async () => {
  if (!db) return;
  await cleanup();
  const now = await snapshot();
  assert.deepEqual(now.products, snap.products, "商品庫存與測試前一致");
  assert.deepEqual(now.variations, snap.variations, "規格庫存與測試前一致");
  assert.deepEqual(now.coupons, snap.coupons, "優惠券與測試前一致");
  assert.deepEqual(now.tables, snap.tables, "訂單／商品／優惠券／明細 筆數與最大 id 與測試前一致");
  console.log(`# 快照比對通過：${JSON.stringify(now.tables)}；商品 ${snap.products.length}、規格 ${snap.variations.length}、優惠券 ${snap.coupons.length} 筆庫存／次數一致`);
});

let pSeq = 0, oSeq = 0, iSeq = 0;
async function mkProduct(qty) {
  const id = PRODUCT_IDS[pSeq++];
  must(await db.from("products").insert({ id, slug: `zz-test-flag-${id}`, name: `TEST 旗標 ${id}`, status: "draft", catalog_visibility: "hidden", manage_stock: true, stock_quantity: qty, stock_status: qty > 0 ? "instock" : "outofstock", backorders: "no", price: 100, regular_price: 100 }));
  return id;
}
async function mkCoupon() {
  must(await db.from("coupons").insert({ id: COUPON_ID, code: `zztestflag${COUPON_ID}`, amount: 10, usage_count: 0, status: "draft" }));
  return { id: COUPON_ID, code: `zztestflag${COUPON_ID}` };
}
async function mkOrder({ productId, qty = 1, method = "ry_ecpay_credit", coupon = null, meta = {} }) {
  const id = ORDER_IDS[oSeq++];
  const total = 100 * qty - (coupon ? 10 : 0);
  must(
    await db.from("orders").insert({
      id, order_key: `wc_order_flag${id}`, status: "pending", payment_method: method, created_via: "checkout",
      billing_email: `flag${id}@example.invalid`, subtotal: 100 * qty, discount_total: coupon ? 10 : 0, total, meta: { test_run: "flag", ...meta },
    }),
  );
  const items = [{ id: ITEM_IDS[iSeq++], order_id: id, item_type: "line_item", name: `TEST 旗標商品 ${productId}`, product_id: productId, quantity: qty, unit_price: 100, subtotal: 100 * qty, total: 100 * qty, meta: {} }];
  if (coupon) items.push({ id: ITEM_IDS[iSeq++], order_id: id, item_type: "coupon", name: coupon.code, quantity: 1, unit_price: -10, subtotal: -10, total: -10, meta: { coupon_id: coupon.id, discount: 10 } });
  must(await db.from("order_items").insert(items));
  return { id, order_key: `wc_order_flag${id}`, total };
}
const rpc = async (fn, args) => must(await db.rpc(fn, args));
const hold = (id, p_hold = true) => rpc("checkout_place_hold", { p_order_id: id, p_hold, p_hold_minutes: 60, p_max_unpaid_per_email: 3, p_max_unpaid_per_ip: 5, p_max_qty_per_item: 5 });
const qtyOf = async (pid) => must(await db.from("products").select("stock_quantity").eq("id", pid).single()).stock_quantity;
const flag = async (id) => must(await db.from("orders").select("meta").eq("id", id).single()).meta.order_stock_reduced;
const setStatus = async (id, status) => must(await db.from("orders").update({ status }).eq("id", id));
const notes = async (id) => must(await db.from("order_notes").select("note").eq("order_id", id).order("id")).map((n) => n.note);
const usage = async (cid) => must(await db.from("coupons").select("usage_count").eq("id", cid).single()).usage_count;

test("cancelled→on-hold→processing：保留時補扣一次，處理中不再扣；優惠券行為不變", SKIP, async () => {
  const pid = await mkProduct(3);
  const c = await mkCoupon();
  const o = await mkOrder({ productId: pid, coupon: c });
  assert.equal(await hold(o.id), "ok");
  assert.equal(await qtyOf(pid), 2);
  assert.equal(await usage(c.id), 1);
  await setStatus(o.id, "cancelled");
  assert.equal(await qtyOf(pid), 3, "取消歸還");
  assert.equal(await flag(o.id), "no");
  assert.equal(await usage(c.id), 0, "取消回補優惠券");
  await setStatus(o.id, "on-hold");
  assert.equal(await qtyOf(pid), 2, "改保留：補扣一次");
  assert.equal(await flag(o.id), "yes");
  assert.ok((await notes(o.id)).some((n) => n.includes("已補扣庫存")));
  await setStatus(o.id, "processing");
  assert.equal(await qtyOf(pid), 2, "改處理中：不重複扣");
});

test("refunded→processing：未付款預留被退款釋放後補扣一次；已付款改已退款不自動回補，再改回處理中不重複扣", SKIP, async () => {
  const pid = await mkProduct(5);
  const a = await mkOrder({ productId: pid });
  assert.equal(await hold(a.id), "ok");
  await setStatus(a.id, "refunded");
  assert.equal(await qtyOf(pid), 5, "預留中改已退款：釋放（現有行為）");
  assert.equal(await flag(a.id), "no");
  await setStatus(a.id, "processing");
  assert.equal(await qtyOf(pid), 4, "refunded→processing 補扣一次");
  assert.equal(await flag(a.id), "yes");

  await setStatus(a.id, "refunded");
  assert.equal(await qtyOf(pid), 4, "已付款改已退款：比照 WooCommerce 不自動回補");
  assert.equal(await flag(a.id), "yes");
  await setStatus(a.id, "processing");
  assert.equal(await qtyOf(pid), 4, "仍是已扣狀態，不重複扣");
});

test("failed→on-hold：失敗釋放後改保留補扣一次；processing→completed 不重複扣；completed→cancelled 歸還一次，再改失敗不重複還", SKIP, async () => {
  const pid = await mkProduct(4);
  const o = await mkOrder({ productId: pid, qty: 2 });
  assert.equal(await hold(o.id), "ok");
  assert.equal(await qtyOf(pid), 2);
  await setStatus(o.id, "failed");
  assert.equal(await qtyOf(pid), 4);
  await setStatus(o.id, "on-hold");
  assert.equal(await qtyOf(pid), 2, "failed→on-hold 補扣");
  await setStatus(o.id, "processing");
  await setStatus(o.id, "completed");
  assert.equal(await qtyOf(pid), 2, "processing→completed 不重複扣");
  await setStatus(o.id, "cancelled");
  assert.equal(await qtyOf(pid), 4, "已扣訂單取消：歸還一次");
  assert.equal(await flag(o.id), "no");
  await setStatus(o.id, "failed");
  assert.equal(await qtyOf(pid), 4, "不重複歸還");
  assert.equal((await notes(o.id)).filter((n) => n.startsWith("已歸還庫存")).length, 1);
});

test("預留轉扣減後（綠界路徑）processing→completed 不重複扣，取消依預留紀錄歸還", SKIP, async () => {
  const pid = await mkProduct(2);
  const o = await mkOrder({ productId: pid });
  assert.equal(await hold(o.id), "ok");
  await setStatus(o.id, "processing");
  assert.equal(await qtyOf(pid), 1, "預留轉扣減，不重複扣");
  await setStatus(o.id, "completed");
  assert.equal(await qtyOf(pid), 1);
  await setStatus(o.id, "cancelled");
  assert.equal(await qtyOf(pid), 2);
});

test("人工付款單：下單不預留；確認（處理中）時扣一次、完成不重複；取消歸還；扣成負數寫備註", SKIP, async () => {
  const pid = await mkProduct(1);
  const m = await mkOrder({ productId: pid, method: "manual" });
  assert.equal(await hold(m.id, false), "ok");
  assert.equal(await qtyOf(pid), 1, "人工付款單下單不預留（現有行為）");
  const m2 = await mkOrder({ productId: pid, method: "manual" });
  assert.equal(await hold(m2.id, false), "ok");
  await setStatus(m.id, "processing");
  assert.equal(await qtyOf(pid), 0);
  await setStatus(m.id, "completed");
  assert.equal(await qtyOf(pid), 0, "不重複扣");
  await setStatus(m2.id, "on-hold");
  assert.equal(await qtyOf(pid), -1, "不檢查庫存直接扣");
  assert.ok((await notes(m2.id)).some((n) => n.includes("負數")));
  await setStatus(m2.id, "cancelled");
  await setStatus(m.id, "cancelled");
  assert.equal(await qtyOf(pid), 1);
});

test("搬遷舊單（WP order_stock_reduced=yes、無預留紀錄）：完成不扣、取消依明細歸還；旗標 no 的已取消舊單改處理中扣一次", SKIP, async () => {
  const pid = await mkProduct(5);
  const legacy = await mkOrder({ productId: pid, qty: 2, method: "bacs", meta: { source: "wp_import", order_stock_reduced: "yes" } });
  await setStatus(legacy.id, "processing");
  await setStatus(legacy.id, "completed");
  assert.equal(await qtyOf(pid), 5, "WP 已扣過，不重複扣");
  await setStatus(legacy.id, "cancelled");
  assert.equal(await qtyOf(pid), 7, "依明細歸還");
  const old = await mkOrder({ productId: pid, method: "bacs", meta: { source: "wp_import", order_stock_reduced: "no" } });
  await setStatus(old.id, "cancelled");
  assert.equal(await qtyOf(pid), 7, "旗標 no：不歸還");
  await setStatus(old.id, "processing");
  assert.equal(await qtyOf(pid), 6);
});
