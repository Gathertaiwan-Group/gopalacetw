// 伺服器端環境變數（值只來自部署環境，不寫入程式碼）
export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const SCHEMA = "site_gopalacetw";
// canonical、og:url、rel=next/prev、RSS、sitemap、robots.txt 使用的網站根網址。
// 由環境變數 SITE_URL 控制；未設定時用 Vercel 提供的正式網域（VERCEL_PROJECT_PRODUCTION_URL，即 gopalacetw.vercel.app），
// 本機則為 http://localhost:3000。切換 DNS 時把 Vercel 的 SITE_URL 設成 https://go.palacetwshop.com 再重新部署即可（見 README）。
const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
export const SITE_URL = (process.env.SITE_URL || (vercelHost ? `https://${vercelHost}` : "http://localhost:3000")).replace(/\/$/, "");
// 顧客自行註冊：舊站沒有註冊表單（features.membership.register_form=[]），且註冊會寫入 Gather 共用 auth.users，
// 預設關閉；主控者核准後設 ENABLE_CUSTOMER_REGISTRATION=1 才開放。
export const REGISTRATION_ENABLED = process.env.ENABLE_CUSTOMER_REGISTRATION === "1";
export const SITE_NAME = "台灣宮廷藝術瓶";
