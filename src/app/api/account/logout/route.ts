import { NextResponse } from "next/server";
import { authClient } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function out(req: Request) {
  const sb = await authClient();
  await sb.auth.signOut();
  return NextResponse.redirect(new URL("/my-account-2/", req.url), 303);
}
export const GET = out;
export const POST = out;
