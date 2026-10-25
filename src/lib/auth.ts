import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";
import { serviceDb } from "./supabase";

/** Supabase Auth（共用專案的 auth；顧客登入狀態存在 httpOnly cookie） */
export async function authClient() {
  const store = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          // Server Component 內無法寫 cookie（只讀），交由 route handler 處理
        }
      },
    },
  });
}

export async function currentUser() {
  try {
    const sb = await authClient();
    const { data } = await sb.auth.getUser();
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** 取得（或建立）本站顧客紀錄：customers.auth_user_id 連結 auth.users */
export async function customerFor(user: { id: string; email?: string | null; email_confirmed_at?: string | null }) {
  const db = serviceDb();
  const { data } = await db.from("customers").select("id,email,billing,shipping").eq("auth_user_id", user.id).maybeSingle();
  if (data) return data;
  const email = (user.email || "").toLowerCase();
  if (email && user.email_confirmed_at) {
    // 第三階段匯入的舊顧客（尚未綁定 auth）以 email 綁定 —— 僅限已完成 email 驗證的帳號，避免冒用他人 email 註冊取得舊訂單
    const { data: legacy } = await db.from("customers").select("id,email,billing,shipping,auth_user_id").ilike("email", email.replace(/[\\%_]/g, (m) => "\\" + m)).is("auth_user_id", null).maybeSingle();
    if (legacy) {
      await db.from("customers").update({ auth_user_id: user.id }).eq("id", legacy.id);
      return legacy;
    }
  }
  const { data: created } = await db
    .from("customers")
    .insert({ auth_user_id: user.id, email, username: email, display_name: email, date_registered: new Date().toISOString() })
    .select("id,email,billing,shipping")
    .single();
  return created;
}
