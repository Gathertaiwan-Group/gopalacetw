// 以 Playwright 截取新站（本機）與 export/screens/ 同一批頁面，計算像素差異。
// 用法：node scripts/frontend/visual-diff.mjs <export_dir> <out_dir> [base] [tools_node_modules]
// 截圖與報告輸出到 out_dir（不在 repo 內）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const exportDir = path.resolve(process.argv[2] || "../export");
const outDir = path.resolve(process.argv[3] || "../work/visual");
const base = (process.argv[4] || "http://localhost:3417").replace(/\/$/, "");
const tools = process.argv[5] || path.join(process.env.HOME, "gather-migrate/_tools/node_modules");
const require = createRequire(path.join(tools, "noop.js"));
const { chromium } = require("playwright");
const sharp = require("sharp");

const OLD = "https://go.palacetwshop.com";
const VIEW = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
fs.mkdirSync(path.join(outDir, "new"), { recursive: true });
fs.mkdirSync(path.join(outDir, "diff"), { recursive: true });

const index = JSON.parse(fs.readFileSync(path.join(exportDir, "screens/index.json"), "utf8"));
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

async function prepare(ctx, name) {
  if (/with-item|cart-panel/.test(name)) {
    const r = await ctx.request.post(base + "/api/cart/", { data: { action: "add", product_id: 2882, quantity: 1 }, headers: { accept: "application/json" } });
    if (!r.ok()) throw new Error("add to cart failed " + r.status());
  }
}

async function shoot(entry) {
  const vp = VIEW[entry.viewport];
  const browser = shoot.browser;
  const ctx = await browser.newContext({
    viewport: vp,
    deviceScaleFactor: 1,
    isMobile: entry.viewport === "mobile",
    hasTouch: entry.viewport === "mobile",
    locale: "zh-TW",
    userAgent: entry.viewport === "mobile" ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 GatherMigrator/1.0" : "Mozilla/5.0 GatherMigrator/1.0",
  });
  // 追蹤碼不要在測試中送出
  await ctx.route(/googletagmanager|facebook\.net|facebook\.com\/tr/, (r) => r.abort());
  await prepare(ctx, entry.name);
  const page = await ctx.newPage();
  const p = entry.url.replace(OLD, "") || "/";
  await page.goto(base + p, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll("img[loading=lazy]").forEach((i) => (i.loading = "eager")));
  // 依序捲過整頁，觸發延遲載入圖片與進場動畫（計數器等），再回到頂端截圖（與舊站截圖流程一致）
  if (!entry.name.includes("cart-panel")) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    // 停在距底部 1500px 前，避免觸發商品列表的無限捲動（舊站截圖多數未載入第 2 頁）
    for (let y = 0; y < h - 1500; y += 600) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, { timeout: 30000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready);
  if (entry.name.includes("cart-panel")) {
    await page.click("#header [data-device=desktop] a.ct-cart-item");
    await page.waitForTimeout(600);
  }
  if (entry.name.includes("checkout-with-item")) await page.waitForTimeout(1200);
  const file = path.join(outDir, "new", `${entry.name}__${entry.viewport}.png`);
  await page.screenshot({ path: file, fullPage: !entry.name.includes("cart-panel") });
  await ctx.close();
  return file;
}

async function diff(oldFile, newFile, name) {
  const W = (await sharp(oldFile).metadata()).width;
  const a = await sharp(oldFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bImg = sharp(newFile).resize({ width: W }).removeAlpha();
  const b = await bImg.raw().toBuffer({ resolveWithObject: true });
  const h1 = a.info.height, h2 = b.info.height;
  const H = Math.min(h1, h2), Hmax = Math.max(h1, h2);
  let differ = 0;
  const mask = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const dd = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (dd > 60) {
        differ++;
        mask[i] = 255; mask[i + 1] = 0; mask[i + 2] = 80;
      } else {
        const g = Math.round((a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3 * 0.35 + 160);
        mask[i] = mask[i + 1] = mask[i + 2] = g;
      }
    }
  }
  const overlap = differ / (W * H);
  const total = (differ + (Hmax - H) * W) / (W * Hmax);
  // 並排圖（舊 | 新 | 差異），縮到寬 1200 以內方便目視
  const third = Math.min(400, W);
  const hh = Math.min(Hmax, 6000);
  const scale = third / W;
  const pane = async (buf, raw, h) =>
    sharp(raw ? buf : buf, raw ? { raw: { width: W, height: h, channels: 3 } } : undefined).extract({ left: 0, top: 0, width: W, height: Math.min(h, hh) }).resize({ width: third }).png().toBuffer();
  const pa = await pane(a.data, true, h1);
  const pb = await pane(b.data, true, h2);
  const pm = await pane(mask, true, H);
  const outH = Math.round(Math.min(hh, Hmax) * scale) + 2;
  await sharp({ create: { width: third * 3 + 20, height: outH, channels: 3, background: "#ff00ff" } })
    .composite([{ input: pa, left: 0, top: 0 }, { input: pb, left: third + 10, top: 0 }, { input: pm, left: third * 2 + 20, top: 0 }])
    .png()
    .toFile(path.join(outDir, "diff", `${name}.png`));
  return { overlap, total, h1, h2 };
}

shoot.browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const results = [];
for (const e of index) {
  if (only && !only.test(e.name)) continue;
  const oldFile = path.join(exportDir, e.file);
  try {
    const nf = await shoot(e);
    const r = await diff(oldFile, nf, `${e.name}__${e.viewport}`);
    results.push({ name: e.name, viewport: e.viewport, url: e.url.replace(OLD, ""), ...r });
    console.log(`${(r.total * 100).toFixed(1).padStart(5)}%  overlap ${(r.overlap * 100).toFixed(1).padStart(5)}%  h ${r.h1}->${r.h2}  ${e.name} ${e.viewport}`);
  } catch (err) {
    console.log("ERR", e.name, e.viewport, String(err).slice(0, 200));
    results.push({ name: e.name, viewport: e.viewport, error: String(err) });
  }
}
await shoot.browser.close();
results.sort((x, y) => (y.total ?? 1) - (x.total ?? 1));
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(results, null, 1));
console.log("\n差異最大的 5 頁：");
for (const r of results.slice(0, 5)) console.log(`  ${((r.total ?? 1) * 100).toFixed(1)}%  ${r.name} (${r.viewport}) ${r.url ?? ""}`);
const ok = results.filter((r) => r.total !== undefined);
console.log(`平均差異 ${(ok.reduce((s, r) => s + r.total, 0) / ok.length * 100).toFixed(1)}%（${ok.length} 張）`);
