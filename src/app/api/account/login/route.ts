import { NextResponse } from "next/server";
import { authClient } from "@/lib/auth";
import { formBody, logSubmission, wantsJson } from "@/lib/forms";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const f = await formBody(req);
  const email = (f.username || f.log || "").trim();
  const password = f.password || f.pwd || "";
  const formSlug = f.form === "header-login" ? "header-login" : "my-account-login";
  const json = wantsJson(req);
  if (!email || !password) {
    await logSubmission(formSlug, { username: email, result: "missing" }, req, "failed");
    return json ? NextResponse.json({ ok: false, error: "請輸入帳號與密碼。" }, { status: 400 }) : NextResponse.redirect(new URL("/my-account-2/?error=" + encodeURIComponent("請輸入帳號與密碼。"), req.url), 303);
  }
  const sb = await authClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  await logSubmission(formSlug, { username: email, rememberme: f.rememberme || "", result: error ? "failed" : "ok" }, req, error ? "failed" : "ok");
  if (error) {
    const msg = "錯誤：使用者名稱或密碼不正確。";
    return json ? NextResponse.json({ ok: false, error: msg }, { status: 401 }) : NextResponse.redirect(new URL("/my-account-2/?error=" + encodeURIComponent(msg), req.url), 303);
  }
  return json ? NextResponse.json({ ok: true, redirect: "/my-account-2/" }) : NextResponse.redirect(new URL("/my-account-2/", req.url), 303);
}
