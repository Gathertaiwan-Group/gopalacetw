import { NextResponse } from "next/server";
import { authClient } from "@/lib/auth";
import { formBody, logSubmission, wantsJson } from "@/lib/forms";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const f = await formBody(req);
  const login = (f.user_login || "").trim().toLowerCase();
  const json = wantsJson(req);
  const msg = "如果此帳號存在，重設密碼的連結已寄到你的電子郵件。";
  await logSubmission("lost-password", { user_login: login }, req);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) {
    const sb = await authClient();
    const origin = new URL(req.url).origin;
    await sb.auth.resetPasswordForEmail(login, { redirectTo: `${origin}/my-account-2/` }).catch(() => null);
  }
  return json ? NextResponse.json({ ok: true, message: msg }) : NextResponse.redirect(new URL("/my-account-2/lost-password/?message=" + encodeURIComponent(msg), req.url), 303);
}
