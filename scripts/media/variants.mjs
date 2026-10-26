// 第三階段：從 export/media 原圖產生響應式 WebP 變體（寬 480/960/1440，q75，不放大），
// 上傳到 site-gopalacetw/v/<寬>/<儲存路徑>，並把變體資訊寫回 media.variants。
// 用法：source ~/.config/gather-migrate/env && node scripts/media/variants.mjs [--dry]
// 只讀本機原圖、只上傳新檔，不從 Supabase 下載任何圖片。
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(process.env.HOME + "/gather-migrate/_tools/node_modules/");
const sharp = require("sharp");

const DRY = process.argv.includes("--dry");
// --only=<storage_path 片段> --upscale480：只處理指定媒體，並允許為小於 480 的原圖產生 480w 變體
// （首屏小圖在 2x 螢幕需要 srcset 候選；正式站首頁 logo 300x182 即此情況）
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const UPSCALE480 = process.argv.includes("--upscale480");
// --widths=320 只產指定寬度，並與 media.variants 既有項目合併（不重傳其他寬度）
const WARG = (process.argv.find((a) => a.startsWith("--widths=")) || "").slice(9);
const WIDTHS = WARG ? WARG.split(",").map(Number) : [320, 480, 960, 1440];
const BUCKET = "site-gopalacetw";
const SCHEMA = "site_gopalacetw";
const SRC = path.join(process.env.HOME, "gather-migrate/gopalacetw/export/media/uploads");
const URL0 = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL0 || !KEY) throw new Error("需先 source ~/.config/gather-migrate/env");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Accept-Profile": SCHEMA, "Content-Profile": SCHEMA };

const res = await fetch(
  `${URL0}/rest/v1/media?select=id,original_path,storage_path,mime_type,width,height,bytes,variants&canonical_media_id=is.null&storage_path=not.is.null&order=id`,
  { headers: H },
);
if (!res.ok) throw new Error("讀 media 失敗 " + res.status + " " + (await res.text()));
const rows = (await res.json()).filter((r) => /^image\/(webp|jpeg|png)$/.test(r.mime_type || ""))
  .filter((r) => !ONLY || (r.storage_path || "").includes(ONLY));
console.log("候選媒體", rows.length);

let up = 0, total = 0, skipped = 0, missing = 0;
const errs = [];
async function one(r) {
  const src = path.join(SRC, r.original_path);
  if (!fs.existsSync(src)) { missing++; errs.push("缺原圖 " + r.original_path); return; }
  const buf = fs.readFileSync(src);
  const meta = await sharp(buf).metadata();
  // 顯示用原圖（已上傳）最長邊 2000；變體寬度以「旋轉後」寬度判斷不放大
  const rotated = meta.orientation && meta.orientation >= 5;
  const srcW = rotated ? meta.height : meta.width;
  const variants = WARG ? (Array.isArray(r.variants) ? r.variants.filter((v) => !WIDTHS.includes(v.w)) : []) : [];
  for (const w of WIDTHS) {
    const forced = UPSCALE480 && w === 480 && srcW < 480;
    if (!forced && (w >= srcW || (r.width && w >= r.width))) continue; // 不放大，也不產生與原圖同寬的重複檔
    const out = await sharp(buf).rotate().resize({ width: w, withoutEnlargement: !forced }).webp({ quality: 75 }).toBuffer({ resolveWithObject: true });
    const rel = r.storage_path.replace(/^uploads\//, "").replace(/\.[^./]+$/, "") + ".webp";
    const key = `v/${w}/${rel}`;
    const enc = key.split("/").map(encodeURIComponent).join("/");
    total += out.data.length;
    if (!DRY) {
      const put = await fetch(`${URL0}/storage/v1/object/${BUCKET}/${enc}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "image/webp", "x-upsert": "true", "cache-control": "public, max-age=31536000, immutable" },
        body: out.data,
      });
      if (!put.ok) throw new Error(key + " " + put.status + " " + (await put.text()));
      up++;
    }
    variants.push({ w: out.info.width, h: out.info.height, path: key, url: `${URL0}/storage/v1/object/public/${BUCKET}/${enc}`, bytes: out.data.length });
  }
  if (!variants.length) skipped++;
  variants.sort((a, b) => a.w - b.w);
  if (!DRY) {
    const patch = await fetch(`${URL0}/rest/v1/media?id=eq.${r.id}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ variants }),
    });
    if (!patch.ok) throw new Error("更新 media " + r.id + " " + patch.status + " " + (await patch.text()));
  }
  return variants;
}
let i = 0;
await Promise.all([0, 1, 2, 3].map(async () => { while (i < rows.length) { const r = rows[i++]; try { await one(r); } catch (e) { errs.push(String(e)); } } }));
console.log(JSON.stringify({ dry: DRY, media: rows.length, uploaded: up, variant_bytes: total, no_variant: skipped, missing, errors: errs.length, sample_errors: errs.slice(0, 5) }));
