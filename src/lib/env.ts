// 伺服器端環境變數（值只來自部署環境，不寫入程式碼）
export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const SCHEMA = "site_gopalacetw";
// canonical / OG 使用的正式網域（DNS 切換前仍指向舊網域，避免 *.vercel.app 被當成重複內容）
export const SITE_URL = (process.env.SITE_URL || "https://go.palacetwshop.com").replace(/\/$/, "");
export const SITE_NAME = "台灣宮廷藝術瓶";
