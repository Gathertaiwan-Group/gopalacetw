import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { publicDb, serviceDb } from "./supabase";

export type Seo = {
  title?: string;
  description?: string;
  robots?: string;
  canonical_path?: string;
  og_type?: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  schema?: unknown;
  [k: string]: unknown;
};

export type Media = {
  id: number;
  slug: string | null;
  title: string | null;
  alt_text: string | null;
  mime_type: string | null;
  public_url: string | null;
  width: number | null;
  height: number | null;
  canonical_media_id: number | null;
  original_path: string;
  variants?: { w: number; h: number; url: string; path?: string; bytes?: number }[];
};

export type Term = {
  id: number;
  taxonomy: string;
  slug: string;
  name: string;
  description: string;
  parent_id: number | null;
  count: number;
  menu_order: number;
  seo: Seo;
  meta: Record<string, unknown>;
};

export type Product = {
  id: number;
  slug: string;
  name: string;
  type: string;
  status: string;
  featured: boolean;
  catalog_visibility: string;
  sku: string | null;
  description: string;
  short_description: string;
  regular_price: string | null;
  sale_price: string | null;
  price: string | null;
  on_sale: boolean;
  date_on_sale_from: string | null;
  date_on_sale_to: string | null;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: "instock" | "outofstock" | "onbackorder";
  backorders: string;
  sold_individually: boolean;
  purchase_min: number;
  purchase_max: number | null;
  menu_order: number;
  featured_media_id: number | null;
  total_sales: number;
  average_rating: string;
  path: string | null;
  meta: Record<string, unknown>;
  seo: Seo;
  published_at: string | null;
  modified_at: string | null;
  // 組合欄位
  images: Media[];
  terms: Term[];
};

export type Variation = {
  id: number;
  product_id: number;
  sku: string | null;
  attributes: Record<string, string>;
  regular_price: string | null;
  sale_price: string | null;
  price: string | null;
  stock_status: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  image_media_id: number | null;
  menu_order: number;
};

export type ProductAttribute = {
  id: number;
  product_id: number;
  attribute_id: number | null;
  name: string;
  options: string[];
  position: number;
  visible: boolean;
  used_for_variations: boolean;
};

export type Post = {
  id: number;
  post_type: string;
  slug: string;
  status: string;
  title: string;
  content: string;
  excerpt: string;
  author_id: number | null;
  parent_id: number | null;
  menu_order: number;
  featured_media_id: number | null;
  template: string;
  path: string | null;
  custom_css: string | null;
  meta: Record<string, unknown>;
  seo: Seo;
  published_at: string | null;
  modified_at: string | null;
};

export type MenuItem = {
  id: number;
  menu_id: number;
  parent_id: number | null;
  position: number;
  title: string;
  url: string;
  object_type: string | null;
  object_id: number | null;
  target: string | null;
  rel: string | null;
  aria_label: string | null;
  css_classes: string[];
  meta: Record<string, unknown>;
};

export type Menu = { id: number; slug: string; name: string; location: string | null; items: MenuItem[] };

export type DiscountRule = {
  id: number;
  slug: string;
  title: string;
  status: string;
  active: boolean | null;
  discount_mode: string | null;
  priority: number | null;
  apply_to: Record<string, unknown>;
  conditions: unknown[];
  rules: unknown[];
  details_status: string;
  path: string | null;
  published_at: string | null;
};

export type Author = { id: number; slug: string | null; display_name: string | null };

async function selectAll<T>(table: string, columns = "*", order?: string): Promise<T[]> {
  const db = publicDb();
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = db.from(table).select(columns).range(from, from + page - 1);
    if (order) q = q.order(order, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data as T[]) || []));
    if (!data || data.length < page) break;
  }
  return out;
}

export type Site = {
  settings: Record<string, any>;
  media: Media[];
  terms: Term[];
  products: Product[];
  variations: Variation[];
  attributes: ProductAttribute[];
  posts: Post[];
  menus: Menu[];
  rules: DiscountRule[];
  authors: Author[];
  urlMap: Record<string, string>;
  redirects: { source_path: string; target: string; status_code: number }[];
};

/** 排程發布：到期的 future 文章／商品改為 publish（每次重建全站快取時執行，最長延遲 = 快取時間 5 分鐘） */
async function promoteScheduled() {
  try {
    const db = serviceDb();
    const now = new Date().toISOString();
    for (const table of ["posts", "products"]) {
      const { data } = await db.from(table).update({ status: "publish" }).eq("status", "future").lte("published_at", now).select("id");
      if (data?.length) {
        await db.from("audit_log").insert(
          data.map((r: { id: number }) => ({ actor_type: "system", actor_id: "scheduler", action: "publish_scheduled", entity_type: table, entity_id: String(r.id), before: { status: "future" }, after: { status: "publish" } })),
        );
      }
    }
  } catch {
    // 沒有 service role（例如本機唯讀）時略過
  }
}

async function loadSite(): Promise<Site> {
  await promoteScheduled();
  const [settingsRows, media, terms, productsRaw, pImages, pTerms, variations, attributes, posts, menus, menuItems, rules, authors, urlMapRows, redirects] =
    await Promise.all([
      selectAll<{ key: string; value: unknown }>("settings", "key,value"),
      selectAll<Media>("media", "id,slug,title,alt_text,mime_type,public_url,width,height,canonical_media_id,original_path,variants"),
      selectAll<Term>("terms", "id,taxonomy,slug,name,description,parent_id,count,menu_order,seo,meta"),
      selectAll<Omit<Product, "images" | "terms">>(
        "products",
        "id,slug,name,type,status,featured,catalog_visibility,sku,description,short_description,regular_price,sale_price,price,on_sale,date_on_sale_from,date_on_sale_to,manage_stock,stock_quantity,stock_status,backorders,sold_individually,purchase_min,purchase_max,menu_order,featured_media_id,total_sales,average_rating,path,meta,seo,published_at,modified_at",
      ),
      selectAll<{ product_id: number; media_id: number; position: number }>("product_images", "product_id,media_id,position"),
      selectAll<{ product_id: number; term_id: number; term_order: number }>("product_terms", "product_id,term_id,term_order"),
      selectAll<Variation>("product_variations", "id,product_id,sku,attributes,regular_price,sale_price,price,stock_status,manage_stock,stock_quantity,image_media_id,menu_order"),
      selectAll<ProductAttribute>("product_attributes", "id,product_id,attribute_id,name,options,position,visible,used_for_variations"),
      selectAll<Post>("posts", "id,post_type,slug,status,title,content,excerpt,author_id,parent_id,menu_order,featured_media_id,template,path,custom_css,meta,seo,published_at,modified_at"),
      selectAll<Omit<Menu, "items">>("menus", "id,slug,name,location"),
      selectAll<MenuItem>("menu_items", "*", "position"),
      selectAll<DiscountRule>("discount_rules", "id,slug,title,status,active,discount_mode,priority,apply_to,conditions,rules,details_status,path,published_at"),
      selectAll<Author>("authors", "id,slug,display_name"),
      selectAll<{ old_url: string; new_url: string }>("media_url_map", "old_url,new_url"),
      selectAll<{ source_path: string; target: string; status_code: number }>("redirects", "source_path,target,status_code"),
    ]);

  const mediaById = new Map(media.map((m) => [m.id, m]));
  const termById = new Map(terms.map((t) => [t.id, t]));
  const settings: Record<string, any> = {};
  for (const r of settingsRows) settings[r.key] = r.value;

  const products: Product[] = productsRaw.map((p) => {
    const imgs = pImages
      .filter((i) => i.product_id === p.id)
      .sort((a, b) => a.position - b.position)
      .map((i) => mediaById.get(i.media_id))
      .filter(Boolean) as Media[];
    if (p.featured_media_id && !imgs.find((m) => m.id === p.featured_media_id)) {
      const f = mediaById.get(p.featured_media_id);
      if (f) imgs.unshift(f);
    }
    const ts = pTerms
      .filter((t) => t.product_id === p.id)
      .sort((a, b) => a.term_order - b.term_order)
      .map((t) => termById.get(t.term_id))
      .filter(Boolean) as Term[];
    return { ...p, images: imgs, terms: ts };
  });

  const urlMap: Record<string, string> = {};
  for (const r of urlMapRows) urlMap[r.old_url] = r.new_url;

  return {
    settings,
    media,
    terms,
    products,
    variations,
    attributes,
    posts,
    menus: menus.map((m) => ({ ...m, items: menuItems.filter((i) => i.menu_id === m.id).sort((a, b) => a.position - b.position) })),
    rules,
    authors,
    urlMap,
    redirects,
  };
}

const cachedSite = unstable_cache(loadSite, ["gopalacetw-site-v2"], { revalidate: 300, tags: ["site"] });

/** 全站內容（約 50 件商品，整包快取 5 分鐘；後台/MCP 寫入後以 revalidateTag('site') 更新） */
export const getSite = cache(async (): Promise<Site> => cachedSite());

export function decodeSlug(s: string): string {
  try {
    return decodeURIComponent(s).normalize("NFC");
  } catch {
    return s;
  }
}

export function sameSlug(a: string, b: string) {
  return decodeSlug(a).toLowerCase() === decodeSlug(b).toLowerCase();
}

/** 舊站網址 → 新網址（媒體對照表） */
export function mapUrl(site: Site, oldUrl: string): string {
  const u = oldUrl.startsWith("/") ? "https://go.palacetwshop.com" + oldUrl : oldUrl;
  return site.urlMap[u] || site.urlMap[u.replace("https://", "http://")] || oldUrl;
}

export function mediaUrl(m: Media | undefined | null): string {
  return m?.public_url || "";
}

/** 依 WooCommerce 預設排序（menu_order ASC, title ASC）；rearrange-woocommerce-products 的自訂順序存在 menu_order */
export function sortProducts(list: Product[], orderby?: string | null, termOrder?: number[] | null): Product[] {
  const arr = [...list];
  // rearrange-woocommerce-products 的「分類專屬順序」：存在 terms.meta.product_order（商品 ID 陣列）
  if ((!orderby || orderby === "menu_order") && termOrder && termOrder.length) {
    const idx = new Map(termOrder.map((id, i) => [id, i]));
    const rank = (p: Product) => idx.get(p.id) ?? Number.MAX_SAFE_INTEGER;
    return arr.sort((a, b) => rank(a) - rank(b) || a.menu_order - b.menu_order || a.name.localeCompare(b.name, "zh-Hant"));
  }
  const price = (p: Product) => Number(p.price ?? 0);
  switch (orderby) {
    case "price":
      return arr.sort((a, b) => price(a) - price(b) || a.menu_order - b.menu_order);
    case "price-desc":
      return arr.sort((a, b) => price(b) - price(a) || a.menu_order - b.menu_order);
    case "date":
      return arr.sort((a, b) => (b.published_at || "").localeCompare(a.published_at || "") || b.id - a.id);
    case "popularity":
      return arr.sort((a, b) => b.total_sales - a.total_sales || a.menu_order - b.menu_order);
    case "rating":
      return arr.sort((a, b) => Number(b.average_rating) - Number(a.average_rating) || a.menu_order - b.menu_order);
    default:
      return arr.sort((a, b) => a.menu_order - b.menu_order || a.name.localeCompare(b.name, "zh-Hant"));
  }
}

export function visibleInCatalog(p: Product) {
  return p.status === "publish" && (p.catalog_visibility === "visible" || p.catalog_visibility === "catalog");
}
export function visibleInSearch(p: Product) {
  return p.status === "publish" && (p.catalog_visibility === "visible" || p.catalog_visibility === "search");
}
