import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

type Redirect = { source_path: string; target: string; status_code: number };

let cache: { at: number; map: Map<string, Redirect> } | null = null;

async function redirects(): Promise<Map<string, Redirect>> {
  if (cache && Date.now() - cache.at < 300_000) return cache.map;
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_ANON_KEY || "";
  const map = new Map<string, Redirect>();
  try {
    const r = await fetch(`${url}/rest/v1/redirects?select=source_path,target,status_code&limit=5000`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "site_gopalacetw" },
    });
    if (r.ok) for (const x of (await r.json()) as Redirect[]) map.set(norm(x.source_path), x);
  } catch {
    // 讀不到轉址表時不阻擋請求
  }
  cache = { at: Date.now(), map };
  return map;
}

function norm(p: string) {
  let s = p;
  try {
    s = decodeURIComponent(p);
  } catch {}
  s = s.normalize("NFC").toLowerCase();
  if (!s.includes("?") && !s.endsWith("/")) s += "/";
  return s;
}

/** 後台與預覽：更新 Supabase Auth session cookie（Server Component 內無法寫 cookie） */
async function withSession(req: NextRequest, headers: Headers) {
  let res = NextResponse.next({ request: { headers } });
  const sb = createServerClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_ANON_KEY || "", {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const c of list) req.cookies.set(c.name, c.value);
        res = NextResponse.next({ request: { headers } });
        for (const c of list) res.cookies.set(c.name, c.value, c.options);
      },
    },
  });
  try {
    await sb.auth.getUser();
  } catch {}
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

// 原本由 matcher 排除、不需前台處理的路徑
const PASSTHROUGH = /^\/(?:_next\/|api\/|wp-content\/|legacy-inline\/|gp-theme\.js$|favicon\.ico$|robots\.txt$|sitemap[^/]*\.xml$|feed\/)/;
// 不補結尾斜線的端點：MCP 客戶端多半不會對 POST 跟隨轉址
const NO_SLASH_ENDPOINTS = new Set(["/api/mcp"]);

export async function proxy(req: NextRequest) {
  const { pathname, search, searchParams } = req.nextUrl;

  // trailingSlash（取代 Next 內建 308；規則相同：最後一段含副檔名者不補）
  if (!pathname.endsWith("/") && !NO_SLASH_ENDPOINTS.has(pathname) && !/\.[^/]+$/.test(pathname)) {
    // 不用 nextUrl.clone()：NextURL 會依 trailingSlash 設定重新格式化路徑
    const u = new URL(req.url);
    u.pathname = pathname + "/";
    return NextResponse.redirect(u.toString(), 308);
  }
  if (PASSTHROUGH.test(pathname)) return NextResponse.next();

  // 後台：獨立版面（根 layout 依 x-gp-admin 分流），不套用前台轉址
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const headers = new Headers(req.headers);
    headers.set("x-gp-admin", "1");
    headers.delete("x-gp-url");
    return withSession(req, headers);
  }

  // 舊 WooCommerce 連結：?add-to-cart=ID、購物車 ?remove_item=
  const add = searchParams.get("add-to-cart");
  if (add && /^\d+$/.test(add)) {
    const u = new URL("/api/cart/", req.url);
    u.searchParams.set("action", "add");
    u.searchParams.set("product_id", add);
    u.searchParams.set("quantity", searchParams.get("quantity") || "1");
    u.searchParams.set("back", pathname);
    return NextResponse.redirect(u, 302);
  }
  const rm = searchParams.get("remove_item");
  if (rm && /^\d+$/.test(rm)) {
    const u = new URL("/api/cart/", req.url);
    u.searchParams.set("action", "remove");
    u.searchParams.set("line", rm);
    u.searchParams.set("back", pathname);
    return NextResponse.redirect(u, 302);
  }

  const map = await redirects();
  // 舊式查詢網址：/?page_id=、/?attachment_id=（附件頁 301 到檔案）、/?p=
  let hit: Redirect | undefined;
  if (pathname === "/") {
    for (const k of ["attachment_id", "page_id", "p"]) {
      const v = searchParams.get(k);
      if (v && /^\d+$/.test(v)) hit = map.get(norm(`/?${k}=${v}`));
      if (hit) break;
    }
  }
  hit = hit || map.get(norm(pathname));
  if (hit && norm(hit.target) !== norm(pathname)) {
    const target = /^https?:\/\//.test(hit.target) ? hit.target : new URL(hit.target, req.url).toString();
    return NextResponse.redirect(target, hit.status_code === 302 || hit.status_code === 307 ? hit.status_code : 301);
  }

  const headers = new Headers(req.headers);
  headers.delete("x-gp-admin");
  headers.set("x-gp-url", pathname + search);
  // 草稿預覽（/__preview/<post|product>/<id>/）：僅管理員可見
  if (pathname.startsWith("/__preview/")) return withSession(req, headers);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // 全路徑（含 /api）都經過 proxy 以處理結尾斜線；_next 內部路徑除外
  matcher: ["/((?!_next/).*)"],
};
