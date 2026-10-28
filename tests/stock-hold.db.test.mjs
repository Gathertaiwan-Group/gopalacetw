// 資料庫整合測試：庫存預留／釋放／轉扣、併發搶最後一件、灌單上限、重複付款防護、優惠券回補、逾期取消、測試金鑰防呆。
// 直接呼叫 site_gopalacetw 的 Postgres 函式（真實併發與交易語意，記憶體模擬測不到）。
// 需要環境變數 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（`source ~/.config/gather-migrate/env`）；未提供則略過。
// 只在 site_gopalacetw 建立草稿測試商品／優惠券／訂單，結束時依建立的 id 逐一刪除（不以時間範圍刪除）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SKIP = { skip: !URL_ || !KEY ? "未提供 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" : false };
const db = URL_ && KEY ? createClient(URL_, KEY, { db: { schema: "site_gopalacetw" }, auth: { persistSession: false } }) : null;

const RUN = randomBytes(4).toString("hex");
const made = { orders: [], products: [], coupons: [] };
let seq = 0;

// 既有商品／規格庫存與優惠券快照：測試後必須與測試前一致（只比對測試前就存在的列）
let snap = null;
async function snapshot() {
  const q = async (t, cols) => {
    const { data, error } = await db.from(t).select(cols).order("id");
    if (error) throw new Error(error.message);
    return data;
  };
  return { products: await q("products", "id,stock_quantity,stock_status"), variations: await q("product_variations", "id,stock_quantity,stock_status"), coupons: await q("coupons", "id,usage_count,used_by") };
}
before(async () => {
  if (db) snap = await snapshot();
});

after(async () => {
  if (!db) return;
  if (made.orders.length) {
    const ids = made.orders.map(String);
    await db.from("audit_log").delete().eq("entity_type", "order").in("entity_id", ids);
    await db.from("orders").delete().in("id", made.orders);
  }
  if (made.products.length) await db.from("products").delete().in("id", made.products);
  if (made.coupons.length) await db.from("coupons").delete().in("id", made.coupons);
  const { count } = await db.from("orders").select("id", { count: "exact", head: true }).in("id", made.orders.length ? made.orders : [0]);
  assert.equal(count || 0, 0, "測試訂單已清除");
  const now = await snapshot();
  const only = (rows, base) => rows.filter((r) => base.some((b) => b.id === r.id));
  for (const k of ["products", "variations", "coupons"]) assert.deepEqual(only(now[k], snap[k]), snap[k], `既有 ${k} 與測試前一致`);
  console.log(`# 快照比對通過（stock-hold）：商品 ${snap.products.length}、規格 ${snap.variations.length}、優惠券 ${snap.coupons.length} 筆與測試前一致；已刪除測試訂單 ${made.orders.length}`);
});

const must = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
async function mkProduct(qty, manage = true) {
  const r = must(
    await db
      .from("products")
      .insert({ slug: `zz-test-hold-${RUN}-${++seq}`, name: `TEST 預留 ${RUN}-${seq}`, status: "draft", catalog_visibility: "hidden", manage_stock: manage, stock_quantity: manage ? qty : null, stock_status: !manage || qty > 0 ? "instock" : "outofstock", backorders: "no", price: 100, regular_price: 100 })
      .select("id")
      .single(),
  );
  made.products.push(r.id);
  return r.id;
}
async function mkCoupon() {
  const r = must(await db.from("coupons").insert({ code: `zztest${RUN}${++seq}`, amount: 10, usage_count: 0, status: "draft" }).select("id,code").single());
  made.coupons.push(r.id);
  return r;
}
async function mkOrder({ productId, qty = 1, coupon = null, email = `t${RUN}-${++seq}@example.invalid`, method = "ry_ecpay_credit", ip = null, ageMinutes = 0 }) {
  const total = 100 * qty - (coupon ? 10 : 0);
  const o = must(
    await db
      .from("orders")
      .insert({
        order_key: `wc_order_test${RUN}${++seq}`,
        status: "pending",
        payment_method: method,
        created_via: "checkout",
        billing_email: email,
        customer_ip: ip,
        subtotal: 100 * qty,
        discount_total: coupon ? 10 : 0,
        total,
        meta: { real_payment: method === "ry_ecpay_credit", test_run: RUN },
        date_created: new Date(Date.now() - ageMinutes * 60000).toISOString(),
      })
      .select("id,order_key")
      .single(),
  );
  made.orders.push(o.id);
  const items = [{ order_id: o.id, item_type: "line_item", name: `TEST 預留商品 ${productId}`, product_id: productId, quantity: qty, unit_price: 100, subtotal: 100 * qty, total: 100 * qty, meta: {} }];
  if (coupon) items.push({ order_id: o.id, item_type: "coupon", name: coupon.code, quantity: 1, unit_price: -10, subtotal: -10, total: -10, meta: { coupon_id: coupon.id, discount: 10 } });
  must(await db.from("order_items").insert(items));
  return { ...o, total, email };
}
const rpc = async (fn, args) => must(await db.rpc(fn, args));
const hold = (id, h = true) => rpc("checkout_place_hold", { p_order_id: id, p_hold: h, p_hold_minutes: 60, p_max_unpaid_per_email: 3, p_max_unpaid_per_ip: 5 });
const begin = (o, tradeNo) => rpc("ecpay_begin_attempt", { p_order_id: o.id, p_order_key: o.order_key, p_trade_no: tradeNo, p_amount: o.total, p_env: "test", p_inflight_minutes: 15, p_hold_minutes: 60, p_max_attempts: 20 });
const notify = (tradeNo, amount, rtn, block = null) =>
  rpc("ecpay_apply_notification", { p_trade_no: tradeNo, p_amount: amount, p_rtn_code: rtn, p_rtn_msg: rtn === "1" ? "交易成功" : "拒絕交易", p_ecpay_trade_no: "T" + tradeNo, p_payment_type: "Credit_CreditCard", p_payment_date: "2026/10/29 10:00:00", p_simulate: false, p_count_as_paid: true, p_block_reason: block });
const tno = () => `${String(++seq).padStart(3, "0")}TS${RUN}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
const stock = async (pid) => must(await db.from("products").select("stock_quantity,stock_status,total_sales").eq("id", pid).single());
const order = async (id) => must(await db.from("orders").select("status,meta").eq("id", id).single());
const holdRow = async (id) => must(await db.from("stock_holds").select("status,held_until").eq("order_id", id).maybeSingle());
const coupon = async (id) => must(await db.from("coupons").select("usage_count,used_by").eq("id", id).single());
const expire = async (id) => must(await db.from("stock_holds").update({ held_until: new Date(Date.now() - 60000).toISOString() }).eq("order_id", id));
const cancelUnpaid = () => rpc("ecpay_cancel_unpaid", { p_minutes: 60 });

test("#1 併發兩單搶最後一件：只有一單成功，庫存不會變負", SKIP, async () => {
  const pid = await mkProduct(1);
  const [a, b] = await Promise.all([mkOrder({ productId: pid }), mkOrder({ productId: pid })]);
  const res = await Promise.all([hold(a.id), hold(b.id)]);
  assert.deepEqual(res.map((r) => (r.startsWith("out_of_stock:") ? "out" : r)).sort(), ["ok", "out"]);
  assert.deepEqual(await stock(pid), { stock_quantity: 0, stock_status: "outofstock", total_sales: 0 });
});

test("#1 併發 6 單搶 2 件：剛好 2 單成功", SKIP, async () => {
  const pid = await mkProduct(2);
  const os = await Promise.all(Array.from({ length: 6 }, () => mkOrder({ productId: pid })));
  const res = await Promise.all(os.map((o) => hold(o.id)));
  assert.equal(res.filter((r) => r === "ok").length, 2);
  assert.equal(res.filter((r) => r.startsWith("out_of_stock:")).length, 4);
  assert.equal((await stock(pid)).stock_quantity, 0);
});

test("#1 失敗釋放 → 重新付款前重新預留 → 付款成功轉扣減，不重複扣；#2 進行中不產生新嘗試", SKIP, async () => {
  const pid = await mkProduct(1);
  const o = await mkOrder({ productId: pid });
  assert.equal(await hold(o.id), "ok");
  assert.equal((await stock(pid)).stock_quantity, 0);
  const t1 = tno();
  assert.equal(await begin(o, t1), "ok");
  assert.equal(await begin(o, tno()), "in_progress", "15 分鐘內已有進行中的付款嘗試");
  assert.equal(await notify(t1, o.total, "10100248"), "failed");
  assert.equal((await order(o.id)).status, "failed");
  assert.equal((await stock(pid)).stock_quantity, 1, "失敗即釋放");
  assert.equal((await holdRow(o.id)).status, "released");
  // 釋放期間被別人買走 → 重新付款被拒（不超賣）
  const other = await mkOrder({ productId: pid });
  assert.equal(await hold(other.id), "ok");
  assert.match(await begin(o, tno()), /^out_of_stock:/);
  await db.from("orders").update({ status: "cancelled" }).eq("id", other.id);
  assert.equal((await stock(pid)).stock_quantity, 1);
  // 重新付款：重新預留、回到等待付款中
  const t2 = tno();
  assert.equal(await begin(o, t2), "ok");
  assert.equal((await stock(pid)).stock_quantity, 0);
  assert.equal((await order(o.id)).status, "pending");
  assert.equal(await notify(t2, o.total, "1"), "paid");
  assert.equal(await notify(t2, o.total, "1"), "already_paid");
  const s = await stock(pid);
  assert.equal(s.stock_quantity, 0, "預留轉扣減，不重複扣");
  assert.equal(s.total_sales, 1);
  assert.equal((await order(o.id)).status, "processing");
  assert.equal((await holdRow(o.id)).status, "converted");
});

test("#1 灌單防護：同 email 未付款線上單上限 3、同 IP 上限 5", SKIP, async () => {
  const pid = await mkProduct(0, false);
  const email = `flood${RUN}@example.invalid`;
  for (let i = 0; i < 3; i++) assert.equal(await hold((await mkOrder({ productId: pid, email })).id), "ok");
  assert.equal(await hold((await mkOrder({ productId: pid, email })).id), "too_many_unpaid");
  const ip = `203.0.113.${(parseInt(RUN.slice(0, 2), 16) % 250) + 1}`;
  for (let i = 0; i < 5; i++) assert.equal(await hold((await mkOrder({ productId: pid, ip })).id), "ok");
  assert.equal(await hold((await mkOrder({ productId: pid, ip })).id), "too_many_unpaid");
  // 人工付款訂單不受線上未付款上限影響
  assert.equal(await hold((await mkOrder({ productId: pid, email, method: "manual" })).id, false), "ok");
});

test("#3 逾期取消回補優惠券且只回補一次；釋放庫存", SKIP, async () => {
  const pid = await mkProduct(2);
  const c = await mkCoupon();
  const o = await mkOrder({ productId: pid, coupon: c });
  assert.equal(await hold(o.id), "ok");
  assert.equal((await coupon(c.id)).usage_count, 1);
  assert.deepEqual((await coupon(c.id)).used_by, [o.email]);
  assert.equal((await stock(pid)).stock_quantity, 1);
  await expire(o.id);
  await cancelUnpaid(); // pg_cron（每 5 分鐘）可能先一步取消，故只驗結果狀態
  assert.equal((await order(o.id)).status, "cancelled");
  assert.equal((await stock(pid)).stock_quantity, 2);
  assert.deepEqual(await coupon(c.id), { usage_count: 0, used_by: [] });
  // 再跑一次取消、或後台把狀態改來改去：不再回補
  await cancelUnpaid();
  await db.from("orders").update({ status: "pending" }).eq("id", o.id);
  await db.from("orders").update({ status: "cancelled" }).eq("id", o.id);
  assert.deepEqual(await coupon(c.id), { usage_count: 0, used_by: [] });
  assert.equal((await stock(pid)).stock_quantity, 2);
});

test("#4 沒有任何付款嘗試的 pending 線上訂單也會逾期取消；人工付款訂單不受影響；失敗訂單也納入", SKIP, async () => {
  const pid = await mkProduct(5);
  const noAttempt = await mkOrder({ productId: pid });
  assert.equal(await hold(noAttempt.id), "ok");
  const manual = await mkOrder({ productId: pid, method: "manual", ageMinutes: 180 });
  assert.equal(await hold(manual.id, false), "ok");
  const failed = await mkOrder({ productId: pid });
  assert.equal(await hold(failed.id), "ok");
  const t = tno();
  assert.equal(await begin(failed, t), "ok");
  assert.equal(await notify(t, failed.total, "10100248"), "failed");
  const fresh = await mkOrder({ productId: pid });
  assert.equal(await hold(fresh.id), "ok");
  await expire(noAttempt.id);
  await expire(failed.id);
  await cancelUnpaid();
  assert.equal((await order(noAttempt.id)).status, "cancelled");
  assert.equal((await order(failed.id)).status, "cancelled");
  assert.equal((await order(manual.id)).status, "pending", "人工付款訂單不自動取消");
  assert.equal((await order(fresh.id)).status, "pending", "未逾期不取消");
  assert.equal((await stock(pid)).stock_quantity, 4, "只剩 fresh 一筆預留");
});

test("#3 取消後才到的付款：重新扣庫存並重新計入優惠券", SKIP, async () => {
  const pid = await mkProduct(3);
  const c = await mkCoupon();
  const o = await mkOrder({ productId: pid, coupon: c });
  assert.equal(await hold(o.id), "ok");
  const t = tno();
  assert.equal(await begin(o, t), "ok");
  await expire(o.id);
  await cancelUnpaid();
  assert.equal((await order(o.id)).status, "cancelled");
  assert.equal((await stock(pid)).stock_quantity, 3);
  assert.equal((await coupon(c.id)).usage_count, 0);
  assert.equal(await notify(t, o.total, "1"), "paid");
  assert.equal((await order(o.id)).status, "processing");
  assert.equal((await stock(pid)).stock_quantity, 2);
  assert.equal((await coupon(c.id)).usage_count, 1);
});

test("#5 測試金鑰用在正式網域：付款成功通知不標記已付款，留後台警示", SKIP, async () => {
  const pid = await mkProduct(1);
  const o = await mkOrder({ productId: pid });
  assert.equal(await hold(o.id), "ok");
  const t = tno();
  assert.equal(await begin(o, t), "ok");
  assert.equal(await notify(t, o.total, "1", "ECPAY_ENV=test，但 SITE_URL 為正式網域"), "blocked_test_env");
  assert.equal(await notify(t, o.total, "1", "ECPAY_ENV=test，但 SITE_URL 為正式網域"), "blocked_test_env");
  const ord = await order(o.id);
  assert.equal(ord.status, "pending");
  const notes = must(await db.from("order_notes").select("note").eq("order_id", o.id));
  assert.ok(notes.some((n) => n.note.includes("警示")));
  const att = must(await db.from("payment_attempts").select("status").eq("merchant_trade_no", t).single());
  assert.equal(att.status, "blocked");
  const logs = must(await db.from("audit_log").select("action").eq("entity_type", "order").eq("entity_id", String(o.id)).eq("action", "payment_blocked_test_env"));
  assert.equal(logs.length, 1);
});
