import { NextResponse } from "next/server";
import { authClient, customerFor } from "@/lib/auth";
import { formBody, logSubmission, wantsJson } from "@/lib/forms";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const f = await formBody(req);
  const email = (f.email || "").trim().toLowerCase();
  const password = f.password || "";
  const json = wantsJson(req);
  const bad = (msg: string, status = 400) =>
    json ? NextResponse.json({ ok: false, error: msg }, { status }) : NextResponse.redirect(new URL("/my-account-2/?error=" + encodeURIComponent(msg), req.url), 303);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("請提供有效的電子郵件地址。");
  if (password.length < 8) return bad("密碼至少需要 8 個字元。");
  const sb = await authClient();
  const origin = new URL(req.url).origin;
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: `${origin}/my-account-2/` } });
  await logSubmission("register", { email, result: error ? error.message : "ok" }, req, error ? "failed" : "ok");
  if (error) return bad(error.message.includes("registered") ? "此電子郵件已註冊，請直接登入。" : "註冊失敗，請稍後再試。");
  if (data.user) await customerFor({ id: data.user.id, email });
  const msg = data.session ? "註冊成功！" : "註冊成功！請至電子郵件收信完成驗證後再登入。";
  return json ? NextResponse.json({ ok: true, message: msg, redirect: "/my-account-2/" }) : NextResponse.redirect(new URL("/my-account-2/?message=" + encodeURIComponent(msg), req.url), 303);
}
