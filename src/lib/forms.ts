import "server-only";
import { serviceDb } from "./supabase";

const SECRET_KEYS = /pass|pwd|token|nonce|card|cvc|cvv/i;

/** 表單提交紀錄（site_gopalacetw.form_submissions）；密碼等敏感欄位一律不存 */
export async function logSubmission(slug: string, data: Record<string, unknown>, req: Request, status = "new") {
  try {
    const db = serviceDb();
    const { data: form } = await db.from("forms").select("id").eq("slug", slug).maybeSingle();
    if (!form) return;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) clean[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
    await db.from("form_submissions").insert({
      form_id: form.id,
      data: clean,
      status,
      ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null,
      user_agent: req.headers.get("user-agent"),
      referrer: req.headers.get("referer"),
    });
  } catch {
    // 紀錄失敗不影響主要流程
  }
}

export async function formBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v == null ? "" : String(v)]));
  }
  const fd = await req.formData().catch(() => null);
  const out: Record<string, string> = {};
  if (fd) for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

export function wantsJson(req: Request) {
  return (req.headers.get("accept") || "").includes("application/json") || (req.headers.get("content-type") || "").includes("application/json");
}
