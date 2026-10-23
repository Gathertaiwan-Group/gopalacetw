import { NextResponse } from "next/server";
import { formBody, logSubmission } from "@/lib/forms";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["search"]);

/** 前台不需伺服器處理的表單（站內搜尋）送出時記錄 */
export async function POST(req: Request) {
  const f = await formBody(req);
  const slug = f.form || "";
  if (!ALLOWED.has(slug)) return NextResponse.json({ ok: false }, { status: 400 });
  const { form, ...data } = f;
  void form;
  if (Object.values(data).join("").length > 500) return NextResponse.json({ ok: false }, { status: 413 });
  await logSubmission(slug, data, req);
  return NextResponse.json({ ok: true });
}
