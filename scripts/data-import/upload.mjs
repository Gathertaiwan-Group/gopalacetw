import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(process.env.HOME + '/gather-migrate/_tools/node_modules/');
const sharp = require('sharp');
const [planFile, outFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const URL0 = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mimeOf = { '.svg': 'image/svg+xml', '.gif': 'image/gif', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webp': 'image/webp' };
const out = [];
async function one(p) {
  const orig = fs.readFileSync(p.src);
  let buf = orig, mime, width = null, height = null;
  if (p.convert) {
    const meta = await sharp(orig).metadata();
    let img = sharp(orig).rotate();
    if (Math.max(meta.width, meta.height) > 2000) img = img.resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true });
    const r = await img.webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    buf = r.data; width = r.info.width; height = r.info.height; mime = 'image/webp';
    // 已是 webp 且未縮放時，重新編碼若反而更大就保留原檔
    if (p.src.toLowerCase().endsWith('.webp') && Math.max(meta.width, meta.height) <= 2000 && orig.length <= buf.length) { buf = orig; width = meta.width; height = meta.height; }
  } else {
    const ext = p.src.slice(p.src.lastIndexOf('.')).toLowerCase();
    mime = mimeOf[ext] || 'application/octet-stream';
    if (ext === '.svg') { const m = String(orig).match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/); if (m) { width = Math.round(+m[1]); height = Math.round(+m[2]); } }
  }
  const enc = p.key.split('/').map(encodeURIComponent).join('/');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${URL0}/storage/v1/object/site-gopalacetw/${enc}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, 'Content-Type': mime, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' }, body: buf });
    if (res.ok) { out.push({ ...p, mime, width, height, bytes: buf.length, original_bytes: orig.length, public_url: `${URL0}/storage/v1/object/public/site-gopalacetw/${enc}` }); return; }
    const t = await res.text(); if (attempt === 2) throw new Error(p.key + ' ' + res.status + ' ' + t);
    await new Promise(r => setTimeout(r, 1000));
  }
}
let i = 0; const errs = [];
await Promise.all([0, 1, 2, 3].map(async () => { while (i < plan.length) { const p = plan[i++]; try { await one(p); } catch (e) { errs.push(String(e)); } } }));
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('uploaded', out.length, 'errors', errs.length, errs.slice(0, 5), 'bytes', out.reduce((a, b) => a + b.bytes, 0), 'orig', out.reduce((a, b) => a + b.original_bytes, 0));
