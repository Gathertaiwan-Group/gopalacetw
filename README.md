# 台灣宮廷藝術瓶（gopalacetw）— Next.js 版

舊站 go.palacetwshop.com（WordPress + WooCommerce + Blocksy）的 Next.js（App Router）重建版，資料在 Supabase schema `site_gopalacetw`，部署於 https://gopalacetw.vercel.app 。

```bash
npm install
npm run dev     # http://localhost:3000
npm run build
```

## 環境變數（只設定在 Vercel / 本機 .env.local，不進 repo）

| 變數 | 說明 |
|---|---|
| `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` | Supabase 連線 |
| `MCP_TOKEN` | `/api/mcp` 的 Bearer token |
| `SITE_URL` | 網站根網址，見下節 |
| `ENABLE_CUSTOMER_REGISTRATION` | 設為 `1` 才開放前台顧客註冊（預設關閉，見下節） |

### SITE_URL 與切換網域

canonical、`og:url`、`rel=next/prev`、RSS `<link rel="alternate">` 與 `/feed/` 項目連結、`/sitemap_index.xml`、各 sitemap、`robots.txt` 的 `Sitemap:` 都以 `SITE_URL` 組成（`src/lib/env.ts`）。

- 未設定時：Vercel 上使用 `VERCEL_PROJECT_PRODUCTION_URL`（即 `https://gopalacetw.vercel.app`），本機為 `http://localhost:3000`。
- 目前 Vercel Production 設為 `SITE_URL=https://gopalacetw.vercel.app`，預覽期間不會有連結指回舊站。
- **切換 DNS 時**：把 Vercel 的 `SITE_URL` 改成 `https://go.palacetwshop.com` 並重新部署，上述連結即全部改用正式網域。

### 顧客註冊

舊站「我的帳號」只有登入表單（沒有註冊表單）。註冊會透過 Supabase Auth 寫入 Gather 共用的 `auth.users`，因此預設關閉：
不顯示註冊連結與表單，`POST /api/account/register/` 回 403。經主控者核准後設 `ENABLE_CUSTOMER_REGISTRATION=1` 才開放。

## MCP 端點

`POST https://gopalacetw.vercel.app/api/mcp`（Streamable HTTP，無狀態，`Authorization: Bearer $MCP_TOKEN`）。
`/api/mcp` 與 `/api/mcp/` 都直接回應，不經 308 轉址（全站結尾斜線補全由 `src/proxy.ts` 處理，MCP 端點例外）。

## 日期

前台顯示的發布日期直接使用 WordPress 的 local `date`（匯入時存在 `meta.wp_date`，`published_at` 為 `date_gmt`），不做時區換算；
後台或 MCP 改過 `published_at` 後，才以 Asia/Taipei（+08:00）由 `published_at` 推算。回填腳本：`scripts/data-import/backfill_wp_date.py`。
