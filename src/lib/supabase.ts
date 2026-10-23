import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SCHEMA, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "./env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
let anon: Db | null = null;
let service: Db | null = null;

/** 公開唯讀（RLS：只讀已發布內容） */
export function publicDb(): Db {
  if (!anon) {
    anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return anon;
}

/** 伺服器端寫入（service role）：只在 route handler / server action 使用 */
export function serviceDb(): Db {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY 未設定");
  if (!service) {
    service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return service;
}
