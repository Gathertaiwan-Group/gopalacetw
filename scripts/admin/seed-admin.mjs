// 建立本站種子管理員（Supabase Admin API，service role）並寫入 site_gopalacetw.admins。
// 用法：source ~/.config/gather-migrate/env && node scripts/admin/seed-admin.mjs
// 密碼由環境變數 ADMIN_PW_GOPALACETW 提供（不寫入 repo、不輸出）。
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = process.env.ADMIN_PW_GOPALACETW;
const EMAIL = "admin+gopalacetw@gathertaiwan.com";
if (!URL_ || !KEY || !PW) throw new Error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ADMIN_PW_GOPALACETW");
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

let r = await fetch(`${URL_}/auth/v1/admin/users`, {
  method: "POST",
  headers: h,
  body: JSON.stringify({ email: EMAIL, password: PW, email_confirm: true, user_metadata: { site: "gopalacetw", role: "admin" } }),
});
let body = await r.json();
if (!r.ok) {
  console.error("建立使用者失敗", r.status, body.msg || body.message || body.error_code);
  process.exit(1);
}
const userId = body.id;
console.log("auth user created", { id: userId, email: body.email, confirmed: !!body.email_confirmed_at });

r = await fetch(`${URL_}/rest/v1/admins?on_conflict=user_id`, {
  method: "POST",
  headers: { ...h, "Content-Profile": "site_gopalacetw", Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify({ user_id: userId, email: EMAIL, role: "owner" }),
});
body = await r.json();
if (!r.ok) {
  console.error("寫入 admins 失敗", r.status, body);
  process.exit(1);
}
console.log("admins row", body);

await fetch(`${URL_}/rest/v1/audit_log`, {
  method: "POST",
  headers: { ...h, "Content-Profile": "site_gopalacetw" },
  body: JSON.stringify({ actor_type: "system", actor_id: "seed-admin", action: "create", entity_type: "admins", entity_id: userId, after: { email: EMAIL, role: "owner" } }),
});
