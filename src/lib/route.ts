import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { wptexturize } from "@/theme/util";
import { decodeSlug, getSite, sameSlug, type DiscountRule, type Post, type Product, type Site, type Term } from "./data";

export const PER_PAGE = 16;

export type Filters = { cats: number[]; min?: number; max?: number; orderby?: string | null };

export type Ctx =
  | { kind: "shop"; page: number; filters: Filters; rule?: DiscountRule }
  | { kind: "product_cat" | "product_tag"; term: Term; page: number; filters: Filters }
  | { kind: "category" | "post_tag"; term: Term; page: number }
  | { kind: "blog"; post: Post; page: number }
  | { kind: "search"; s: string; page: number; postType?: string | null }
  | { kind: "product"; product: Product }
  | { kind: "page"; post: Post; special?: "cart" | "checkout" | "account"; sub?: string[] }
  | { kind: "ct_content_block"; post: Post }
  | { kind: "notfound" };

export type ReqInfo = { pathname: string; search: URLSearchParams };

export const getReq = cache(async (): Promise<ReqInfo> => {
  const h = await headers();
  const raw = h.get("x-gp-url") || "/";
  const u = new URL(raw, "http://local");
  return { pathname: u.pathname, search: u.searchParams };
});

function parseFilters(sp: URLSearchParams): Filters {
  const cats = (sp.get("filter_product_cat") || "")
    .split(",")
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isFinite(n));
  const min = sp.get("min_price");
  const max = sp.get("max_price");
  return {
    cats,
    min: min !== null && min !== "" ? Number(min) : undefined,
    max: max !== null && max !== "" ? Number(max) : undefined,
    orderby: sp.get("orderby"),
  };
}

/** 去掉 /page/N/ 分頁尾巴 */
function splitPaged(segs: string[]): { segs: string[]; page: number } | null {
  const n = segs.length;
  if (n >= 2 && segs[n - 2] === "page") {
    const p = Number(segs[n - 1]);
    if (!Number.isInteger(p) || p < 1) return null;
    return { segs: segs.slice(0, n - 2), page: p };
  }
  return { segs, page: 1 };
}

function findPageByPath(site: Site, path: string): Post | undefined {
  const want = decodeSlug(path).replace(/\/+$/, "/");
  return site.posts.find((p) => p.post_type === "page" && p.status === "publish" && p.path && decodeSlug(p.path) === want);
}

/** 彙整頁的商品數（與 theme/render applyFilters 相同條件），用於判斷分頁是否超出範圍 → 404 */
function archiveCount(site: Site, termId: number | null, f: Filters) {
  return site.products.filter((p) => {
    if (p.status !== "publish" || !(p.catalog_visibility === "visible" || p.catalog_visibility === "catalog")) return false;
    if (termId !== null && !p.terms.some((t) => t.id === termId)) return false;
    if (f.cats.length && !p.terms.some((t) => f.cats.includes(t.id))) return false;
    const price = Number(p.price || 0);
    if (f.min !== undefined && price < f.min) return false;
    if (f.max !== undefined && price > f.max) return false;
    return true;
  }).length;
}
function pageInRange(n: number, page: number) {
  return page === 1 || page <= Math.ceil(n / PER_PAGE);
}

export function resolveCtx(site: Site, req: ReqInfo): Ctx {
  const sp = req.search;
  const rawSegs = req.pathname.split("/").filter(Boolean).map(decodeSlug);
  const s = sp.get("s");

  // 搜尋：/?s=...（WordPress 對任何路徑帶 s 都視為搜尋；舊站只用首頁）
  if (s !== null && (rawSegs.length === 0 || (rawSegs.length === 2 && rawSegs[0] === "page"))) {
    const page = rawSegs.length === 2 ? Number(rawSegs[1]) : 1;
    return { kind: "search", s, page: Number.isInteger(page) && page > 0 ? page : 1, postType: sp.get("post_type") };
  }

  const paged = splitPaged(rawSegs);
  if (!paged) return { kind: "notfound" };
  const { segs, page } = paged;

  // 首頁 = 商店頁（page 1035 "Shop"）
  if (segs.length === 0) {
    const filters = parseFilters(sp);
    if (!pageInRange(archiveCount(site, null, filters), page)) return { kind: "notfound" };
    return { kind: "shop", page, filters };
  }

  const [first, second] = segs;

  if (first === "product" && segs.length === 2 && page === 1) {
    const product = site.products.find((p) => p.status === "publish" && sameSlug(p.slug, second));
    return product ? { kind: "product", product } : { kind: "notfound" };
  }

  if ((first === "product-category" || first === "product-tag") && segs.length === 2) {
    const tax = first === "product-category" ? "product_cat" : "product_tag";
    const term = site.terms.find((t) => t.taxonomy === tax && sameSlug(t.slug, second));
    if (!term) return { kind: "notfound" };
    const filters = parseFilters(sp);
    if (!pageInRange(archiveCount(site, term.id, filters), page)) return { kind: "notfound" };
    return { kind: tax, term, page, filters };
  }

  if ((first === "category" || first === "tag") && segs.length === 2) {
    const tax = first === "category" ? "category" : "post_tag";
    const term = site.terms.find((t) => t.taxonomy === tax && sameSlug(t.slug, second));
    if (!term) return { kind: "notfound" };
    if (page > 1) return { kind: "notfound" }; // 0 篇文章，沒有第 2 頁
    return { kind: tax, term, page };
  }

  if (first === "ywdpd_discount" && segs.length === 2) {
    const rule = site.rules.find((r) => r.status === "publish" && sameSlug(r.slug, second));
    if (!rule) return { kind: "notfound" };
    // YITH 規則頁在舊站呈現為商店彙整（同首頁）
    const filters = parseFilters(sp);
    if (!pageInRange(archiveCount(site, null, filters), page)) return { kind: "notfound" };
    return { kind: "shop", page, filters, rule };
  }

  if (first === "ct_content_block" && segs.length === 2 && page === 1) {
    const post = site.posts.find((p) => p.post_type === "ct_content_block" && p.status === "publish" && sameSlug(p.slug, second));
    return post ? { kind: "ct_content_block", post } : { kind: "notfound" };
  }

  // WooCommerce 頁面（含子端點）
  const pages = site.settings.pages || {};
  const special: Record<string, "cart" | "checkout" | "account"> = {
    [String(pages.cart || "/cart-2/").replace(/\//g, "")]: "cart",
    [String(pages.checkout || "/checkout-2/").replace(/\//g, "")]: "checkout",
    [String(pages.my_account || "/my-account-2/").replace(/\//g, "")]: "account",
  };
  if (special[first] && page === 1) {
    const post = findPageByPath(site, `/${first}/`);
    if (post) {
      const kind = special[first];
      const sub = segs.slice(1);
      if (kind === "cart" && sub.length) return { kind: "notfound" };
      if (kind === "checkout" && sub.length && sub[0] !== "order-received") return { kind: "notfound" };
      if (kind === "account" && sub.length && !["orders", "view-order", "lost-password", "edit-account", "customer-logout", "reset-password"].includes(sub[0]))
        return { kind: "notfound" };
      return { kind: "page", post, special: kind, sub };
    }
  }

  // 文章列表頁（page_for_posts = 20 /blog-2/）
  const reading = site.settings.reading || {};
  const blogPost = site.posts.find((p) => p.id === reading.page_for_posts);
  if (blogPost && segs.length === 1 && blogPost.path && sameSlug(blogPost.path.replace(/\//g, ""), first)) {
    if (page > 1) return { kind: "notfound" };
    return { kind: "blog", post: blogPost, page };
  }

  // 一般頁面（含階層）
  if (page === 1) {
    const path = "/" + segs.join("/") + "/";
    const post = findPageByPath(site, path);
    if (post && post.id !== reading.page_on_front) return { kind: "page", post };
  }
  return { kind: "notfound" };
}

export type SiteCtx = { site: Site; ctx: Ctx; req: ReqInfo };

/** 依路徑解析（ISR 公開頁：不讀 headers/cookies，路徑來自路由參數） */
export const ctxFor = cache(async (pathname: string, search: string): Promise<SiteCtx> => {
  const site = await getSite();
  const req: ReqInfo = { pathname, search: new URLSearchParams(search) };
  if (pathname.startsWith("/__preview/")) return { site, ctx: await previewCtx(site, req), req };
  return { site, ctx: resolveCtx(site, req), req };
});

/** 路由參數 → 網址路徑（與舊站相同，一律斜線結尾） */
export function pathFromSlug(slug: string[] | undefined): string {
  const segs = (slug || []).map((s) => {
    try {
      return encodeURIComponent(decodeURIComponent(s));
    } catch {
      return s;
    }
  });
  return segs.length ? `/${segs.join("/")}/` : "/";
}

/** 動態請求（購物車／結帳／會員／搜尋／篩選／預覽）：路徑與查詢字串由 proxy 以 x-gp-url 傳入 */
export const getCtx = cache(async (): Promise<SiteCtx> => {
  const req = await getReq();
  return ctxFor(req.pathname, req.search.toString());
});

/** 後台草稿預覽：/__preview/post/<id>/、/__preview/product/<id>/（僅管理員；以 service role 讀未發布內容） */
async function previewCtx(site: Site, req: ReqInfo): Promise<Ctx> {
  const [, , kind, rawId] = req.pathname.split("/");
  const id = Number(rawId);
  if (!Number.isInteger(id)) return { kind: "notfound" };
  const { getAdmin } = await import("./admin/guard");
  if (!(await getAdmin())) return { kind: "notfound" };
  const { serviceDb } = await import("./supabase");
  const db = serviceDb();
  if (kind === "post") {
    const { data } = await db.from("posts").select("*").eq("id", id).maybeSingle();
    if (!data) return { kind: "notfound" };
    const post = data as Post;
    return post.post_type === "ct_content_block" ? { kind: "ct_content_block", post } : { kind: "page", post };
  }
  if (kind === "product") {
    const { data } = await db.from("products").select("*").eq("id", id).maybeSingle();
    if (!data) return { kind: "notfound" };
    const [{ data: imgs }, { data: pts }] = await Promise.all([
      db.from("product_images").select("media_id,position").eq("product_id", id).order("position"),
      db.from("product_terms").select("term_id,term_order").eq("product_id", id).order("term_order"),
    ]);
    const images = (imgs || []).map((i) => site.media.find((m) => m.id === i.media_id)).filter(Boolean) as Product["images"];
    if (data.featured_media_id && !images.find((m) => m.id === data.featured_media_id)) {
      const f = site.media.find((m) => m.id === data.featured_media_id);
      if (f) images.unshift(f);
    }
    const terms = (pts || []).map((t) => site.terms.find((x) => x.id === t.term_id)).filter(Boolean) as Term[];
    return { kind: "product", product: { ...(data as Omit<Product, "images" | "terms">), name: wptexturize(data.name), raw_name: data.name, images, terms } };
  }
  return { kind: "notfound" };
}
