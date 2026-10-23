// /admin 後台端對端測試（Playwright）：登入 → 逐頁巡覽 → UI 建立草稿／預覽／排程／刪除 → 媒體上傳轉 WebP 後刪除。
// 用法：source ~/.config/gather-migrate/env && PW_CHANNEL=chrome ADMIN_URL=http://localhost:3000 NODE_PATH=~/gather-migrate/_tools/node_modules node scripts/admin/admin-e2e.mjs
// 密碼由 ADMIN_PW_GOPALACETW 提供，不輸出。測試建立的資料會在結尾刪除。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const sharp = require(process.env.SHARP_PATH || "sharp");

const BASE = (process.env.ADMIN_URL || "http://localhost:3000").replace(/\/$/, "");
const EMAIL = "admin+gopalacetw@gathertaiwan.com";
const PW = process.env.ADMIN_PW_GOPALACETW;
if (!PW) throw new Error("缺少 ADMIN_PW_GOPALACETW");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("dialog", (d) => d.accept());

// 未登入 → 轉到登入頁
await page.goto(`${BASE}/admin/products/`);
check("未登入導向登入頁", page.url().includes("/admin/login"), page.url());

// 錯誤密碼
await page.fill("#email", EMAIL);
await page.fill("#password", "wrong-password-xyz");
await page.click("button[type=submit]");
await page.waitForSelector(".adm-flash.err", { timeout: 15000 }).catch(() => null);
check("錯誤密碼被拒", (await page.locator(".adm-flash.err").count()) > 0 && page.url().includes("/admin/login"));

// 正確登入
await page.fill("#email", EMAIL);
await page.fill("#password", PW);
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/admin/login"), { timeout: 30000 }), page.click("button[type=submit]")]);
check("管理員登入成功", !page.url().includes("/admin/login"), page.url());

// 巡覽所有後台頁
const PAGES = [
  ["控制台", "/admin/"],
  ["文章", "/admin/content/?type=post"],
  ["頁面", "/admin/content/?type=page"],
  ["內容區塊", "/admin/content/?type=ct_content_block"],
  ["文章分類", "/admin/e/terms/?taxonomy=category"],
  ["媒體庫", "/admin/media/"],
  ["商品", "/admin/products/"],
  ["商品分類", "/admin/e/terms/?taxonomy=product_cat"],
  ["商品標籤", "/admin/e/terms/?taxonomy=product_tag"],
  ["商品屬性", "/admin/e/attributes/"],
  ["訂單", "/admin/orders/"],
  ["顧客", "/admin/e/customers/"],
  ["優惠券", "/admin/e/coupons/"],
  ["數量折扣", "/admin/e/discount_rules/"],
  ["選單", "/admin/menus/"],
  ["表單提交", "/admin/forms/"],
  ["轉址", "/admin/e/redirects/"],
  ["網站設定", "/admin/settings/"],
  ["稽核紀錄", "/admin/audit/"],
  ["管理員", "/admin/e/admins/"],
];
for (const [label, path] of PAGES) {
  const r = await page.goto(BASE + path);
  const h1 = (await page.locator("h1").first().textContent().catch(() => "")) || "";
  const body = await page.locator("body").innerText();
  const ok = r.status() === 200 && !/Application error|Internal Server Error|找不到頁面/.test(body) && h1.trim().length > 0;
  check(`頁面 ${label} ${path}`, ok, `${r.status()} h1=「${h1.trim().slice(0, 30)}」`);
}

// 商品列表數量與一個商品編輯頁
await page.goto(`${BASE}/admin/products/`);
const prodLinks = await page.locator('a[href^="/admin/products/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href")).filter((h) => /\/admin\/products\/\d+\/?$/.test(h)))]);
check("商品列表有商品連結", prodLinks.length > 0, `${prodLinks.length} 個`);
if (prodLinks[0]) {
  const r = await page.goto(BASE + prodLinks[0]);
  const hasPrice = (await page.locator('[name="regular_price"]').count()) > 0 && (await page.locator('[name="stock_quantity"]').count()) > 0;
  check("商品編輯頁含價格與庫存欄位", r.status() === 200 && hasPrice, prodLinks[0]);
}

// UI：新增文章草稿（所見即所得）→ 預覽 → 排程 → 移到垃圾桶 → 永久刪除
const stamp = Date.now();
const title = `E2E 後台測試草稿 ${stamp}`;
await page.goto(`${BASE}/admin/content/new/?type=post`);
await page.fill('input[name="title"]', title);
const ed = page.locator(".ed").first();
await ed.click();
await page.keyboard.type("所見即所得編輯器輸入的內文");
await Promise.all([page.waitForURL(/\/admin\/content\/\d+\/\?ok=/, { timeout: 30000 }), page.click('button[value="draft"]')]);
const postId = /\/admin\/content\/(\d+)\//.exec(page.url())?.[1];
check("UI 儲存草稿", !!postId && (await page.locator(".adm-flash").innerText()).includes("草稿"), `id=${postId}`);

const pv = await page.goto(`${BASE}/__preview/post/${postId}/`);
const pvText = await page.locator("body").innerText();
check("草稿預覽", pv.status() === 200 && pvText.includes(title) && pvText.includes("所見即所得編輯器輸入的內文"), `status ${pv.status()} title=${pvText.includes(title)} body=${pvText.includes("所見即所得編輯器輸入的內文")} url=${page.url()}`);

// 未登入時草稿不可見於前台預覽
const anon = await browser.newPage();
const anonPv = await anon.goto(`${BASE}/__preview/post/${postId}/`);
const anonText = await anon.locator("body").innerText();
check("未登入看不到草稿預覽", !anonText.includes(title), `status ${anonPv.status()}`);
await anon.close();

await page.goto(`${BASE}/admin/content/${postId}/`);
const future = new Date(Date.now() + 7 * 864e5);
const pad = (n) => String(n).padStart(2, "0");
await page.fill("#published_at", `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:00`);
await Promise.all([page.waitForURL(/ok=/, { timeout: 30000 }), page.click('button[value="schedule"]')]);
check("UI 排程", (await page.locator("body").innerText()).includes("排程"));

await page.goto(`${BASE}/admin/content/${postId}/`);
await Promise.all([page.waitForURL(/\/admin\/content\/\?type=post/, { timeout: 30000 }), page.click("text=移到垃圾桶")]);
check("UI 移到垃圾桶", page.url().includes("/admin/content/"));

// 媒體：上傳 PNG → 應轉成 WebP
const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 200, g: 40, b: 60 } } }).png().toBuffer();
await page.goto(`${BASE}/admin/media/`);
await page.setInputFiles('input[type="file"][name="files"]', { name: `e2e-test-${stamp}.png`, mimeType: "image/png", buffer: png });
await Promise.all([page.waitForURL(/\/admin\/media\/\?(ok|error)=/, { timeout: 60000 }), page.locator('input[type="file"][name="files"]').evaluate((i) => i.form.requestSubmit())]);
const flash = await page.locator(".adm-flash").first().innerText();
check("媒體上傳", flash.includes("已上傳 1"), flash);
const mediaLink = await page.locator(`a[href^="/admin/media/"]`).evaluateAll((as, s) => {
  const a = as.find((x) => (x.closest("tr,li,div")?.textContent || "").includes(`e2e-test-${s}`) && /\/admin\/media\/\d+\/?$/.test(x.getAttribute("href")));
  return a?.getAttribute("href");
}, String(stamp));
let mediaOk = false;
if (mediaLink) {
  await page.goto(BASE + mediaLink);
  const txt = await page.locator("body").innerText();
  const src = await page.locator('img[src*="site-gopalacetw"]').first().getAttribute("src").catch(() => null);
  let dims = "";
  if (src) {
    const buf = Buffer.from(await (await fetch(src)).arrayBuffer());
    const meta = await sharp(buf).metadata();
    dims = `${meta.format} ${meta.width}x${meta.height}`;
    mediaOk = meta.format === "webp" && Math.max(meta.width, meta.height) <= 2000;
  }
  check("上傳檔已轉 WebP 且最長邊 ≤2000", mediaOk, `${src?.split("/").slice(-3).join("/")} ${dims} ${txt.includes("image/webp") ? "(mime image/webp)" : ""}`);
  await Promise.all([page.waitForURL(/\/admin\/media\/\?/, { timeout: 30000 }), page.click("text=永久刪除")]);
  check("UI 刪除測試媒體", (await page.locator(".adm-flash").first().innerText()).length > 0);
} else check("找到上傳的測試媒體", false);

await browser.close();
// 清理：永久刪除測試草稿（僅本站 schema、僅此筆）
if (postId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&status=eq.trash`, { method: "DELETE", headers: { apikey: k, Authorization: `Bearer ${k}`, "Content-Profile": "site_gopalacetw" } });
  console.log(`清理測試草稿 #${postId}：HTTP ${r.status}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n結果：${results.length - failed.length}/${results.length} PASS`);
console.log(JSON.stringify({ postId }));
process.exit(failed.length ? 1 : 0);
