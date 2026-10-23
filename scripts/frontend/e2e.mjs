// 前台功能實測（本機）：加入購物車、迷你購物車、購物車更新、優惠券、結帳建立待付款訂單、登入錯誤、搜尋、選單、燈箱
// 用法：node scripts/frontend/e2e.mjs [base] [tools_node_modules] [shots_dir]
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
const base = (process.argv[2] || "http://localhost:3417").replace(/\/$/, "");
const tools = process.argv[3] || path.join(process.env.HOME, "gather-migrate/_tools/node_modules");
const shots = process.argv[4] || path.resolve("../work/e2e");
fs.mkdirSync(shots, { recursive: true });
const require = createRequire(path.join(tools, "noop.js"));
const { chromium } = require("playwright");

const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: "Mozilla/5.0 GatherMigrator/1.0 e2e" });
await ctx.route(/googletagmanager|facebook\.net|facebook\.com\/tr/, (r) => r.abort());
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// 1. 商品頁 → 浮動列加入購物車
await page.goto(base + "/product/art1/", { waitUntil: "networkidle" });
check("商品頁標題", (await page.textContent("h1.product_title"))?.includes("兵士令"));
await page.mouse.wheel(0, 1200);
await page.waitForTimeout(500);
check("浮動加入購物車列出現", (await page.getAttribute(".ct-drawer-canvas[data-location=start]", "data-floating-bar")) === "yes");
await page.fill(".ct-floating-bar input.qty", "2");
await page.click(".ct-floating-bar .single_add_to_cart_button");
await page.waitForSelector("#woo-cart-panel.active", { timeout: 10000 }).catch(() => {});
check("加入後側邊購物車開啟", await page.isVisible("#woo-cart-panel.active"));
const count = await page.textContent("#header [data-device=desktop] .ct-dynamic-count-cart");
check("頁首購物車數量 = 2", count?.trim() === "2", `count=${count}`);
check("迷你購物車小計 NT$4,000", (await page.textContent("#woo-cart-panel .woocommerce-mini-cart__total"))?.includes("4,000"));
await page.screenshot({ path: path.join(shots, "mini-cart.png") });
await page.click("#woo-cart-panel .ct-toggle-close");

// 2. 售罄商品無法加入
const r = await ctx.request.post(base + "/api/cart/", { data: { action: "add", product_id: 2056, quantity: 1 }, headers: { accept: "application/json" } });
check("售罄商品拒絕加入", r.status() === 400, (await r.json()).error);

// 3. 購物車頁：更新數量、優惠券錯誤
await page.goto(base + "/cart-2/", { waitUntil: "networkidle" });
check("購物車頁有 1 列商品", (await page.locator("tr.cart_item").count()) === 1);
await page.fill("td.product-quantity input.qty", "3");
await page.click("button[name=update_cart]");
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1800);
check("更新數量後小計 NT$6,000", (await page.textContent("tr.cart-subtotal td"))?.includes("6,000"));
check("滿 6000 免運", (await page.textContent("tr.shipping"))?.includes("免運費"));
await page.fill("#coupon_code", "NOPE-123");
await page.click("button[name=apply_coupon]");
await page.waitForTimeout(1200);
check("無效優惠券顯示錯誤", (await page.textContent(".woocommerce-notices-wrapper"))?.includes("不存在"));
await page.fill("td.product-quantity input.qty", "1");
await page.click("button[name=update_cart]");
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1800);
check("數量 1 → 小計 NT$2,000、運費 NT$150、總計 NT$2,150", (await page.textContent("tr.order-total"))?.includes("2,150"));

// 4. 結帳：加價購彈窗、送出建立待付款訂單
await page.goto(base + "/checkout-2/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const popupVisible = await page.isVisible(".ywdpd_popup");
check("結帳頁 YITH 加價購彈窗", popupVisible);
if (popupVisible) await page.click(".ywdpd_no_thanks");
await page.click("#place_order");
await page.waitForLoadState("networkidle");
check("缺欄位時顯示錯誤", (await page.textContent(".woocommerce-notices-wrapper"))?.includes("必填"));
await page.fill("#billing_first_name", "測試");
await page.fill("#billing_last_name", "前台");
await page.fill("#billing_address_1", "測試路 1 號");
await page.fill("#billing_city", "中正區");
await page.selectOption("select[name=billing_county]", "臺北市");
await page.fill("#billing_postcode", "100");
await page.fill("#billing_phone", "0912345678");
await page.fill("#billing_email", "e2e-test+gopalacetw@example.com");
await page.fill("#order_comments", "E2E 測試訂單（可刪）");
await Promise.all([page.waitForURL(/order-received/, { timeout: 20000 }), page.click("#place_order")]).catch(() => {});
const url = page.url();
const m = url.match(/order-received\/(\d+)\//);
check("結帳後導向訂單完成頁", !!m, url.replace(base, ""));
check("訂單完成頁顯示待付款說明", (await page.textContent("main"))?.includes("待付款"));
await page.screenshot({ path: path.join(shots, "order-received.png"), fullPage: true });
fs.writeFileSync(path.join(shots, "order.json"), JSON.stringify({ order_id: m ? Number(m[1]) : null }));
await page.goto(base + "/cart-2/", { waitUntil: "networkidle" });
check("下單後購物車清空", (await page.textContent("main"))?.includes("購物車目前是空的"));

// 5. 我的帳號：錯誤登入、註冊驗證（不實際建立帳號）、忘記密碼
await page.goto(base + "/my-account-2/", { waitUntil: "networkidle" });
await page.fill("#username", "nobody-e2e@example.com");
await page.fill("#password", "wrong-password-e2e");
await page.click("button[name=login]");
await page.waitForTimeout(2500);
check("錯誤密碼顯示錯誤訊息", (await page.textContent(".woocommerce-notices-wrapper"))?.includes("不正確"));
const reg = await ctx.request.post(base + "/api/account/register/", { data: { email: "bad-email", password: "x" }, headers: { accept: "application/json" } });
check("註冊表單驗證（無效 email）", reg.status() === 400);
const lp = await ctx.request.post(base + "/api/account/lost-password/", { data: { user_login: "e2e-not-an-email" }, headers: { accept: "application/json" } });
check("忘記密碼表單送出", lp.ok());

// 6. 頁首帳號彈窗、手機選單、搜尋
await page.goto(base + "/", { waitUntil: "networkidle" });
await page.click("#header [data-device=desktop] .ct-account-item");
await page.waitForTimeout(400);
check("帳號彈窗開啟", await page.isVisible("#account-modal.active"));
await page.fill("#user_login", "nobody-e2e@example.com");
await page.fill("#user_pass", "wrong");
await page.click("#account-modal .ct-account-login-submit");
await page.waitForTimeout(2500);
check("彈窗登入錯誤訊息", (await page.textContent("#account-modal"))?.includes("不正確"));
await page.keyboard.press("Escape");
await page.goto(base + "/?s=" + encodeURIComponent("瓶"), { waitUntil: "networkidle" });
check("搜尋結果頁", (await page.locator(".entries article").count()) === 6, `${await page.locator(".entries article").count()} 筆/頁`);
await page.goto(base + "/blog-2/", { waitUntil: "networkidle" });
await page.fill("form.ct-search-form input[name=s]", "財神");
await Promise.all([page.waitForURL(/\?s=/), page.press("form.ct-search-form input[name=s]", "Enter")]);
check("搜尋表單送出", (await page.textContent("h1.page-title"))?.includes("財神"));

// 7. 篩選、分頁、無限捲動
await page.goto(base + "/?filter_product_cat=60", { waitUntil: "networkidle" });
check("分類篩選（招財進寶）", (await page.locator("ul.products > li").count()) === 10, `${await page.locator("ul.products > li").count()} 件`);
await page.goto(base + "/", { waitUntil: "networkidle" });
const before = await page.locator("ul.products > li").count();
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(700);
}
const after = await page.locator("ul.products > li").count();
check("無限捲動載入第 2、3 頁", before === 16 && after === 43, `${before} → ${after}`);

// 8. 燈箱、手機抽屜
await page.goto(base + "/product/art888/", { waitUntil: "networkidle" });
await page.click(".woocommerce-product-gallery__trigger");
await page.waitForTimeout(300);
check("商品圖燈箱開啟", await page.isVisible(".gp-lightbox"));
check("燈箱按鈕（關閉/分享/全螢幕/縮放/上下張）", (await page.locator(".gp-lightbox button").count()) >= 6);
await page.screenshot({ path: path.join(shots, "lightbox.png") });
await page.keyboard.press("Escape");
const m2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m2.newPage();
await mp.goto(base + "/", { waitUntil: "networkidle" });
await mp.click("#header [data-device=mobile] .ct-header-trigger");
await mp.waitForTimeout(500);
check("手機選單抽屜開啟", await mp.isVisible("#offcanvas.active"));
await mp.screenshot({ path: path.join(shots, "mobile-menu.png") });
await mp.mouse.wheel(0, 600);
await mp.waitForTimeout(300);

await page.goto(base + "/", { waitUntil: "networkidle" });
await page.mouse.wheel(0, 500);
await page.waitForTimeout(400);
check("黏性頁首（捲動後 data-sticky 含 yes）", ((await page.getAttribute("#header [data-device=desktop] [data-sticky]", "data-sticky")) || "").includes("yes"));

check("頁面無 JS 錯誤", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} 通過`);
process.exit(fails.length ? 1 : 0);
