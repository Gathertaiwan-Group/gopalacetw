// node --test tests/（Node 22.18+／23.6+ 內建 TypeScript type stripping）
// 測試向量來源：ecpay skill test-vectors/checkmacvalue.json（綠界官方公開測試特店 3002607）。
// 金鑰不寫進 repo：官方向量測試需以環境變數提供測試特店 HashKey/HashIV，否則略過；
//   ECPAY_TEST_HASH_KEY=<測試 HashKey> ECPAY_TEST_HASH_IV=<測試 HashIV> npm test
// 其餘測試使用與真實金鑰無關的假金鑰。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateCheckMacValue,
  verifyCheckMacValue,
  ecpayUrlEncode,
  generateTradeNo,
  tradeNoToOrderId,
  isValidTradeNo,
  buildCheckoutParams,
  processReturnNotification,
  configFromEnv,
  sanitizeItemName,
  taipeiDate,
} from "../src/lib/ecpay/core.ts";

const OKEY = process.env.ECPAY_TEST_HASH_KEY || "";
const OIV = process.env.ECPAY_TEST_HASH_IV || "";
const NOVEC = { skip: !OKEY || !OIV ? "未提供 ECPAY_TEST_HASH_KEY / ECPAY_TEST_HASH_IV" : false };
const KEY = "dummyHashKey0001";
const IV = "dummyHashIV00001";
const CFG = { merchantId: "3002607", hashKey: KEY, hashIv: IV, env: "test" };

test("CheckMacValue：官方 AIO 基線向量", NOVEC, () => {
  const p = { MerchantID: "3002607", MerchantTradeNo: "Test1234567890", MerchantTradeDate: "2025/01/01 12:00:00", PaymentType: "aio", TotalAmount: "100", TradeDesc: "測試", ItemName: "測試商品", ReturnURL: "https://example.com/notify", ChoosePayment: "ALL", EncryptType: "1" };
  assert.equal(generateCheckMacValue(p, OKEY, OIV), "291CBA324D31FB5A4BBBFDF2CFE5D32598524753AFD4959C3BF590C5B2F57FB2");
});

test("CheckMacValue：特殊字元 ' ~ 空白 向量", NOVEC, () => {
  assert.equal(generateCheckMacValue({ MerchantID: "3002607", ItemName: "Tom's Shop", TotalAmount: "100" }, OKEY, OIV), "CF0A3D4901D99459D8641516EC57210700E8A5C9AB26B1D021301E9CB93EF78D");
  assert.equal(generateCheckMacValue({ MerchantID: "3002607", ItemName: "Test~Product", TotalAmount: "200" }, OKEY, OIV), "CEEAE01D2F9A8E74D4AC0DCE7735B046D73F35A5EC99558A31A2EE03159DA1C9");
  assert.equal(generateCheckMacValue({ MerchantID: "3002607", ItemName: "My Test Product", TotalAmount: "300" }, OKEY, OIV), "7712A5E6EDC3B57086063C88568084C66CE882A21D40E74DE5ACA3B478C6F316");
  assert.equal(ecpayUrlEncode("a b~'(*)!-_."), "a+b%7e%27(*)!-_.");
});

const CALLBACK = { MerchantID: "3002607", MerchantTradeNo: "Test1234567890", RtnCode: "1", RtnMsg: "Succeeded", TradeNo: "2301011234567890", TradeAmt: "100", PaymentDate: "2025/01/01 12:05:00", PaymentType: "Credit_CreditCard", TradeDate: "2025/01/01 12:00:00", SimulatePaid: "0" };

test("CheckMacValue：官方 Callback 向量驗章通過", NOVEC, () => {
  const cmv = generateCheckMacValue(CALLBACK, OKEY, OIV);
  assert.equal(cmv, "2AB536D86AFF8E1086744D59175040A32538C96B1C28C4135B551BD728E913B8");
  assert.equal(verifyCheckMacValue({ ...CALLBACK, CheckMacValue: cmv }, OKEY, OIV), true);
});

test("壞簽章被拒：竄改欄位、錯誤值、缺值、錯誤金鑰", () => {
  const cmv = generateCheckMacValue(CALLBACK, KEY, IV);
  assert.equal(verifyCheckMacValue({ ...CALLBACK, TradeAmt: "1", CheckMacValue: cmv }, KEY, IV), false);
  assert.equal(verifyCheckMacValue({ ...CALLBACK, CheckMacValue: "0".repeat(64) }, KEY, IV), false);
  assert.equal(verifyCheckMacValue({ ...CALLBACK, CheckMacValue: "" }, KEY, IV), false);
  assert.equal(verifyCheckMacValue({ ...CALLBACK, CheckMacValue: cmv }, "wrongkey12345678", IV), false);
  // 額外欄位（NeedExtraPaidInfo=Y）也必須參與驗章
  assert.equal(verifyCheckMacValue({ ...CALLBACK, card4no: "2222", CheckMacValue: cmv }, KEY, IV), false);
});

test("MerchantTradeNo：唯一、英數、≤20 字，可反推訂單 ID", () => {
  const a = generateTradeNo(1003456, 1761700000000, 3);
  assert.equal(a, "1003456TS300000716");
  assert.ok(isValidTradeNo(a) && a.length <= 20);
  assert.equal(tradeNoToOrderId(a), 1003456);
  assert.notEqual(generateTradeNo(1003456, 1761700001000, 3), a);
  assert.equal(isValidTradeNo("ABC-123"), false);
  assert.equal(isValidTradeNo("A".repeat(21)), false);
});

test("付款表單：參數與簽章、時區、ItemName 消毒", () => {
  const p = buildCheckoutParams(CFG, { tradeNo: "1000001TS1234", amount: 1580, itemName: "素還真<b>紀念</b> & 高粱|酒", tradeDesc: "台灣宮廷藝術瓶", returnUrl: "https://x.test/api/ecpay/notify/", orderResultUrl: "https://x.test/r/", clientBackUrl: "https://x.test/b/", now: Date.UTC(2026, 0, 1, 16, 0, 0) });
  assert.equal(p.MerchantTradeDate, "2026/01/02 00:00:00");
  assert.equal(p.TotalAmount, "1580");
  assert.equal(p.ChoosePayment, "Credit");
  assert.equal(p.ItemName, "素還真紀念  高粱酒");
  assert.equal(verifyCheckMacValue(p, KEY, IV), true);
  assert.throws(() => buildCheckoutParams(CFG, { tradeNo: "1000001TS1234", amount: 0, itemName: "x", tradeDesc: "x", returnUrl: "", orderResultUrl: "", clientBackUrl: "" }));
  assert.equal(sanitizeItemName(""), "商品");
  assert.match(taipeiDate(), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("未設金鑰或 ECPAY_ENV 不合法 → 不啟用", () => {
  assert.equal(configFromEnv({}), null);
  assert.equal(configFromEnv({ ECPAY_MERCHANT_ID: "1", ECPAY_HASH_KEY: "k", ECPAY_HASH_IV: "v" }), null);
  assert.equal(configFromEnv({ ECPAY_MERCHANT_ID: "1", ECPAY_HASH_KEY: "k", ECPAY_HASH_IV: "v", ECPAY_ENV: "prod" }), null);
  assert.deepEqual(configFromEnv({ ECPAY_MERCHANT_ID: "1", ECPAY_HASH_KEY: "k", ECPAY_HASH_IV: "v", ECPAY_ENV: "production" }), { merchantId: "1", hashKey: "k", hashIv: "v", env: "production" });
});

// ---- ReturnURL 處理：用記憶體 store 模擬資料庫函式的冪等語意 ----
function memStore() {
  const st = { attempts: new Map([["1000001TS1234", { merchant_trade_no: "1000001TS1234", order_id: 1000001, amount: 1580, status: "created" }]]), order: { status: "pending", stock: 10, paidCount: 0 }, applyCalls: 0 };
  return {
    st,
    async findAttempt(no) {
      const a = st.attempts.get(no);
      return a ? { merchant_trade_no: a.merchant_trade_no, order_id: a.order_id, amount: a.amount } : null;
    },
    async apply(i) {
      st.applyCalls++;
      const a = st.attempts.get(i.tradeNo);
      if (!a) return "unknown_trade_no";
      if (i.amount !== a.amount) return "amount_mismatch";
      if (i.rtnCode !== "1") return a.status === "failed" ? "already_failed" : ((a.status = "failed"), (st.order.status = "failed"), "failed");
      if (!i.countAsPaid) return "simulated";
      if (a.status === "paid") return "already_paid";
      a.status = "paid";
      st.order.status = "processing";
      st.order.stock -= 1;
      st.order.paidCount++;
      return "paid";
    },
  };
}
const notif = (over = {}) => {
  const p = { MerchantID: "3002607", MerchantTradeNo: "1000001TS1234", RtnCode: "1", RtnMsg: "交易成功", TradeNo: "2610291234567890", TradeAmt: "1580", PaymentDate: "2026/10/29 10:00:00", PaymentType: "Credit_CreditCard", PaymentTypeChargeFee: "40", TradeDate: "2026/10/29 09:59:00", SimulatePaid: "0", card4no: "2222", ...over };
  return { ...p, CheckMacValue: generateCheckMacValue(p, KEY, IV) };
};

test("ReturnURL：成功 → 1|OK，訂單已付款", async () => {
  const s = memStore();
  const r = await processReturnNotification(notif(), CFG, s);
  assert.deepEqual([r.status, r.body, r.result], [200, "1|OK", "paid"]);
  assert.equal(s.st.order.status, "processing");
});

test("ReturnURL 冪等：重送 3 次只處理一次、庫存只扣一次、每次都回 1|OK", async () => {
  const s = memStore();
  const n = notif();
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await processReturnNotification(n, CFG, s));
  assert.deepEqual(results.map((r) => r.body), ["1|OK", "1|OK", "1|OK", "1|OK"]);
  assert.deepEqual(results.map((r) => r.result), ["paid", "already_paid", "already_paid", "already_paid"]);
  assert.equal(s.st.order.paidCount, 1);
  assert.equal(s.st.order.stock, 9);
});

test("ReturnURL：壞簽章被拒，不碰資料庫", async () => {
  const s = memStore();
  const bad = { ...notif(), CheckMacValue: "A".repeat(64) };
  const r = await processReturnNotification(bad, CFG, s);
  assert.equal(r.result, "bad_signature");
  assert.notEqual(r.body, "1|OK");
  const tampered = { ...notif(), TradeAmt: "1" }; // 竄改金額但沿用原簽章
  assert.equal((await processReturnNotification(tampered, CFG, s)).result, "bad_signature");
  assert.equal(s.st.applyCalls, 0);
  assert.equal(s.st.order.status, "pending");
});

test("ReturnURL：金額不符被拒（即使簽章正確）", async () => {
  const s = memStore();
  const r = await processReturnNotification(notif({ TradeAmt: "1" }), CFG, s);
  assert.equal(r.result, "amount_mismatch");
  assert.notEqual(r.body, "1|OK");
  assert.equal(s.st.order.status, "pending");
  assert.equal(s.st.order.paidCount, 0);
});

test("ReturnURL：特店編號不符、未知交易編號被拒", async () => {
  const s = memStore();
  assert.equal((await processReturnNotification(notif({ MerchantID: "2000132" }), CFG, s)).result, "merchant_mismatch");
  assert.equal((await processReturnNotification(notif({ MerchantTradeNo: "9999999TS1" }), CFG, s)).result, "unknown_trade_no");
  assert.equal(s.st.order.status, "pending");
});

test("ReturnURL：失敗通知 → 訂單失敗（冪等），正式環境模擬付款不算付款", async () => {
  const s = memStore();
  const f = notif({ RtnCode: "10100248", RtnMsg: "拒絕交易" });
  assert.equal((await processReturnNotification(f, CFG, s)).result, "failed");
  assert.equal((await processReturnNotification(f, CFG, s)).result, "already_failed");
  assert.equal(s.st.order.status, "failed");
  const s2 = memStore();
  const r = await processReturnNotification(notif({ SimulatePaid: "1" }), { ...CFG, env: "production" }, s2);
  assert.deepEqual([r.body, r.result], ["1|OK", "simulated"]);
  assert.equal(s2.st.order.status, "pending");
});
