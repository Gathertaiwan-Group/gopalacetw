// 檢查舊站 urls.json 的每個網址在新站的回應（預設 http://localhost:3417）
// 用法：node scripts/frontend/check-urls.mjs <export_dir> [base]
import fs from "node:fs";
const exportDir = process.argv[2] || "../export";
const base = (process.argv[3] || "http://localhost:3417").replace(/\/$/, "");
const u = JSON.parse(fs.readFileSync(`${exportDir}/urls.json`, "utf8"));
const urls = [...new Set([...u.urls, ...(u.pagination_only || [])])];
const OLD = "https://go.palacetwshop.com";
let ok = 0, redir = 0, bad = 0;
const rows = [];
for (const full of urls) {
  const path = full.replace(OLD, "") || "/";
  const r = await fetch(base + path, { redirect: "manual" });
  let final = r.status;
  let loc = r.headers.get("location") || "";
  if (r.status >= 300 && r.status < 400) {
    const r2 = await fetch(new URL(loc, base + path), { redirect: "follow" });
    final = r2.status;
    redir++;
  }
  const good = (r.status === 200) || (r.status >= 300 && r.status < 400 && final === 200);
  if (r.status === 200) ok++;
  if (!good) bad++;
  rows.push(`${good ? "OK " : "BAD"} ${r.status}${loc ? " -> " + decodeURIComponent(loc.replace(base, "")) + " -> " + final : ""}  ${decodeURIComponent(path)}`);
}
console.log(rows.join("\n"));
console.log(`\n總數 ${urls.length}：直接 200 = ${ok}，轉址後 200 = ${redir - (urls.length - ok - bad - redir < 0 ? 0 : 0)}，失敗 = ${bad}`);
process.exit(bad ? 1 : 0);
