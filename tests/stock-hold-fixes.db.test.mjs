// 資料庫整合測試（綠界複驗修正 2026-10-29）：
//   1a pg_cron job site_gopalacetw_expire_holds 存在且 command 可執行；1c 單品數量上限；逾期單釋放後併發搶最後一件只成功一單
//   2  開始付款後預留期限 ≥ 付款鎖結束＋5 分鐘，鎖期間不會被逾期取消
//   3  取消／失敗後被改回處理中／完成 → 補扣庫存一次（不檢查庫存，負數寫備註）
// 需要 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（cron 檢查另需 SUPABASE_ACCESS_TOKEN）；未提供則略過。
// 只用本測試建立的草稿商品／優惠券／訂單（記錄 id，結束時逐筆刪除）；並比對測試前後既有商品庫存與優惠券快照。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PAT = process.env.SUPABASE_ACCESS_TOKEN || "";
const PROJECT = "ozwftlkgqmewtadypsfi";
const SKIP = { skip: !URL_ || !KEY ? "未提供 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" : false };
const SKIP_CRON = { skip: !PAT ? "未提供 SUPABASE_ACCESS_TOKEN" : SKIP.skip };
const db = URL_ && KEY ? createClient(URL_, KEY, { db: { schema: "site_gopalacetw" }, auth: { persistSession: false } }) : null;

const RUN = randomBytes(4).toString("hex");
const made = { orders: [], products: [], coupons: [] };
let seq = 0;
let snap = null;

const must = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
async function snapshot() {
  const products = must(await db.from("products").select("id,stock_quantity,stock_status").order("id"));
  const variations = must(await db.from("product_variations").select("id,stock_quantity,stock_status").order("id"));
  const coupons = must(await db.from("coupons").select("id,usage_count,used_by").order("id"));
  return { products, variations, coupons };
}

before(async () => {
  if (db) snap = await snapshot();
});

after(async () => {
  if (!db) return;
  for (const id of made.orders) {
    await db.from("audit_log").delete().eq("entity_type", "order").eq("entity_id", String(id));
    await db.from("orders").delete().eq("id", id);
  }
  for (const id of made.products) await db.from("products").delete().eq("id", id);
  for (const id of made.coupons) await db.from("coupons").delete().eq("id", id);
  const { count } = await db.from("orders").select("id", { count: "exact", head: true }).in("id", made.orders.length ? made.orders : [0]);
  assert.equal(count || 0, 0, "測試訂單已清除");
  const { count: pc } = await db.from("products").select("id", { count: "exact", head: true }).in("id", made.products.length ? made.products : [0]);
  assert.equal(pc || 0, 0, "測試商品已清除");
  // 只比對測試開始前就存在的列（其他測試檔同時建立的測試列不算）
  const now = await snapshot();
  const only = (rows, base) => rows.filter((r) => base.some((b) => b.id === r.id));
  assert.deepEqual(only(now.products, snap.products), snap.products, "既有商品庫存與測試前一致");
  assert.deepEqual(only(now.variations, snap.variations), snap.variations, "規格庫存與測試前一致");
  assert.deepEqual(only(now.coupons, snap.coupons), snap.coupons, "既有優惠券與測試前一致");
  console.log(`# 快照比對通過：商品 ${snap.products.length}、規格 ${snap.variations.length}、優惠券 ${snap.coupons.length} 筆與測試前一致；已逐筆刪除測試訂單 ${made.orders.length}、商品 ${made.products.length}`);
});

async function mkProduct(qty) {
  const r = must(
    await db
      .from("products")
      .insert({ slug: `zz-test-fix-${RUN}-${++seq}`, name: `TEST 複驗 ${RUN}-${seq}`, status: "draft", catalog_visibility: "hidden", manage_stock: true, stock_quantity: qty, stock_status: qty > 0 ? "instock" : "outofstock", backorders: "no", price: 100, regular_price: 100 })
      .select("id")
      .single(),
  );
  made.products.push(r.id);
  return r.id;
}
async function mkOrder({ productId, qty = 1 }) {
  const total = 100 * qty;
  const o = must(
    await db
      .from("orders")
      .insert({
        order_key: `wc_order_fix${RUN}${++seq}`,
        status: "pending",
        payment_method: "ry_ecpay_credit",
        created_via: "checkout",
        billing_email: `f${RUN}-${seq}@example.invalid`,
        subtotal: total,
        total,
        meta: { real_payment: true, test_run: RUN },
      })
      .select("id,order_key")
      .single(),
  );
  made.orders.push(o.id);
  must(await db.from("order_items").insert([{ order_id: o.id, item_type: "line_item", name: `TEST 複驗商品 ${productId}`, product_id: productId, quantity: qty, unit_price: 100, subtotal: total, total, meta: {} }]));
  return { ...o, total };
}
const rpc = async (fn, args) => must(await db.rpc(fn, args));
const hold = (id, extra = {}) => rpc("checkout_place_hold", { p_order_id: id, p_hold: true, p_hold_minutes: 60, p_max_unpaid_per_email: 3, p_max_unpaid_per_ip: 5, p_max_qty_per_item: 5, ...extra });
const begin = (o, tradeNo) => rpc("ecpay_begin_attempt", { p_order_id: o.id, p_order_key: o.order_key, p_trade_no: tradeNo, p_amount: o.total, p_env: "test", p_inflight_minutes: 15, p_hold_minutes: 60, p_max_attempts: 20 });
const notify = (tradeNo, amount, rtn) =>
  rpc("ecpay_apply_notification", { p_trade_no: tradeNo, p_amount: amount, p_rtn_code: rtn, p_rtn_msg: rtn === "1" ? "交易成功" : "拒絕交易", p_ecpay_trade_no: "T" + tradeNo, p_payment_type: "Credit_CreditCard", p_payment_date: "2026/10/29 10:00:00", p_simulate: false, p_count_as_paid: true, p_block_reason: null });
const tno = () => `${String(++seq).padStart(3, "0")}FX${RUN}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
const qtyOf = async (pid) => must(await db.from("products").select("stock_quantity").eq("id", pid).single()).stock_quantity;
const order = async (id) => must(await db.from("orders").select("status,meta").eq("id", id).single());
const holdRow = async (id) => must(await db.from("stock_holds").select("status,held_until").eq("order_id", id).maybeSingle());
const setHeldUntil = async (id, msFromNow) => must(await db.from("stock_holds").update({ held_until: new Date(Date.now() + msFromNow).toISOString() }).eq("order_id", id));
const setStatus = async (id, status) => must(await db.from("orders").update({ status }).eq("id", id));
const notes = async (id) => must(await db.from("order_notes").select("note").eq("order_id", id).order("id")).map((n) => n.note);
const cancelUnpaid = () => rpc("ecpay_cancel_unpaid", { p_minutes: 60 });

async function mgmt(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`management api ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

test("#1a pg_cron job 存在、每 5 分鐘、只呼叫本站函式，command 手動執行無錯誤", SKIP_CRON, async () => {
  const jobs = await mgmt("select jobname, schedule, command, active from cron.job where jobname like 'site_gopalacetw%'");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobname, "site_gopalacetw_expire_holds");
  assert.equal(jobs[0].schedule, "*/5 * * * *");
  assert.equal(jobs[0].active, true);
  assert.match(jobs[0].command, /^select site_gopalacetw\.ecpay_cancel_unpaid\(60\)$/);
  const out = await mgmt(jobs[0].command);
  assert.equal(typeof out[0].ecpay_cancel_unpaid, "number");
});

test("#1a 排程用的同一指令會取消逾期單並釋放庫存（不需任何人造訪網站）", SKIP_CRON, async () => {
  const pid = await mkProduct(1);
  const o = await mkOrder({ productId: pid });
  assert.equal(await hold(o.id), "ok");
  assert.equal(await qtyOf(pid), 0);
  await setHeldUntil(o.id, -60000);
  const jobs = await mgmt("select command from cron.job where jobname = 'site_gopalacetw_expire_holds'");
  await mgmt(jobs[0].command);
  assert.equal((await order(o.id)).status, "cancelled");
  assert.equal(await qtyOf(pid), 1);
});

test("#1 逾期單釋放後，兩單併發搶最後一件：只有一單成功", SKIP, async () => {
  const pid = await mkProduct(1);
  const stale = await mkOrder({ productId: pid });
  assert.equal(await hold(stale.id), "ok");
  const [a, b] = await Promise.all([mkOrder({ productId: pid }), mkOrder({ productId: pid })]);
  assert.match(await hold(a.id), /^out_of_stock:/, "預留中，買不到");
  await setHeldUntil(stale.id, -60000);
  await cancelUnpaid();
  assert.equal(await qtyOf(pid), 1);
  const [c, d] = await Promise.all([mkOrder({ productId: pid }), mkOrder({ productId: pid })]);
  const res = await Promise.all([hold(c.id), hold(d.id), hold(b.id)]);
  assert.equal(res.filter((r) => r === "ok").length, 1);
  assert.equal(res.filter((r) => r.startsWith("out_of_stock:")).length, 2);
  assert.equal(await qtyOf(pid), 0, "不會變負");
});

test("#1c 單品數量上限：6 件拒絕（不扣庫存）、5 件可下單", SKIP, async () => {
  const pid = await mkProduct(20);
  const big = await mkOrder({ productId: pid, qty: 6 });
  assert.match(await hold(big.id), /^qty_limit:/);
  assert.equal(await qtyOf(pid), 20);
  assert.equal(await holdRow(big.id), null);
  const ok = await mkOrder({ productId: pid, qty: 5 });
  assert.equal(await hold(ok.id), "ok");
  assert.equal(await qtyOf(pid), 15);
});

test("#2 開始付款：預留期限 ≥ 付款鎖（15 分）＋5 分；鎖期間逾期取消不會取消它", SKIP, async () => {
  const pid = await mkProduct(1);
  const o = await mkOrder({ productId: pid });
  assert.equal(await hold(o.id), "ok");
  await setHeldUntil(o.id, 60000); // 預留只剩 1 分鐘
  const t0 = Date.now();
  assert.equal(await begin(o, tno()), "ok");
  const until = new Date((await holdRow(o.id)).held_until).getTime();
  assert.ok(until >= t0 + 20 * 60000 - 5000, `held_until 應 ≥ 現在＋20 分鐘，實際只多 ${Math.round((until - t0) / 60000)} 分`);
  await cancelUnpaid();
  assert.equal((await order(o.id)).status, "pending");
  assert.equal(await qtyOf(pid), 0);
});

test("#3 取消後被後台改回處理中：補扣一次、扣成負數寫備註；再改完成不重複扣", SKIP, async () => {
  const pid = await mkProduct(1);
  const a = await mkOrder({ productId: pid });
  assert.equal(await hold(a.id), "ok");
  await setStatus(a.id, "cancelled");
  assert.equal(await qtyOf(pid), 1);
  assert.equal((await order(a.id)).meta.order_stock_reduced, "no");
  const b = await mkOrder({ productId: pid });
  assert.equal(await hold(b.id), "ok", "取消期間被別人買走");
  assert.equal(await qtyOf(pid), 0);
  await setStatus(a.id, "processing");
  assert.equal(await qtyOf(pid), -1, "錢已收：不檢查庫存直接補扣");
  assert.equal((await order(a.id)).meta.order_stock_reduced, "yes");
  const ns = await notes(a.id);
  assert.ok(ns.some((n) => n.includes("已補扣庫存")));
  assert.ok(ns.some((n) => n.includes("負數")));
  await setStatus(a.id, "completed");
  assert.equal(await qtyOf(pid), -1, "不重複扣");
  // 清理：把 b 取消釋放，商品稍後整筆刪除
  await setStatus(b.id, "cancelled");
});

test("#3 付款失敗（已釋放）後被改成完成：補扣一次；綠界通知路徑不會被觸發器重複扣", SKIP, async () => {
  const pid = await mkProduct(3);
  const o = await mkOrder({ productId: pid, qty: 2 });
  assert.equal(await hold(o.id), "ok");
  const t = tno();
  assert.equal(await begin(o, t), "ok");
  assert.equal(await notify(t, o.total, "10100248"), "failed");
  assert.equal(await qtyOf(pid), 3);
  await setStatus(o.id, "completed");
  assert.equal(await qtyOf(pid), 1);
  assert.ok(!(await notes(o.id)).some((n) => n.includes("負數")), "未扣成負數不寫負數警示");

  // 取消後才到的綠界付款：apply_notification 自行扣減一次，觸發器不再補扣
  const o2 = await mkOrder({ productId: pid });
  assert.equal(await hold(o2.id), "ok");
  const t2 = tno();
  assert.equal(await begin(o2, t2), "ok");
  await setStatus(o2.id, "cancelled");
  assert.equal(await qtyOf(pid), 1);
  assert.equal(await notify(t2, o2.total, "1"), "paid");
  assert.equal(await qtyOf(pid), 0, "只扣一次");
  assert.ok(!(await notes(o2.id)).some((n) => n.includes("已補扣庫存")));
});
