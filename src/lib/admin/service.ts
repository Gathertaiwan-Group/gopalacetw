/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { createHash } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import sharp from "sharp";
import { serviceDb } from "@/lib/supabase";
import { entityDef, ORDER_STATUS_LABEL, type EntityDef } from "./entities";

/** 後台與 MCP 共用的資料存取層：欄位白名單、正規化、稽核紀錄、前台快取更新 */

export type Actor = {
  type: "admin" | "mcp" | "system";
  id?: string | null;
  email?: string | null;
  ip?: string | null;
  ua?: string | null;
};

export class AdminError extends Error {}

export const BUCKET = "site-gopalacetw";
type Row = Record<string, any>;

// ---------- 共用 ----------

export function refreshSite() {
  try {
    revalidateTag("site", { expire: 0 });
    // 公開頁為 ISR（revalidate 300）：寫入後立即清掉全站頁面快取
    revalidatePath("/", "layout");
  } catch {
    // 不在 Next 請求環境（例如腳本）時略過
  }
}

export async function audit(actor: Actor, action: string, entityType: string, entityId: unknown, before: unknown, after: unknown) {
  const { error } = await serviceDb()
    .from("audit_log")
    .insert({
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      actor_email: actor.email ?? null,
      action,
      entity_type: entityType,
      entity_id: entityId === null || entityId === undefined ? null : String(entityId),
      before: before ?? null,
      after: after ?? null,
      ip: actor.ip ?? null,
      user_agent: actor.ua ? actor.ua.slice(0, 300) : null,
    });
  if (error) console.error("audit_log insert failed:", error.message);
}

function fail(prefix: string, error: { message: string } | null) {
  if (error) throw new AdminError(`${prefix}：${error.message}`);
}

function pkValue(def: EntityDef, id: unknown) {
  if (def.pkType === "number") {
    const n = Number(id);
    if (!Number.isInteger(n)) throw new AdminError(`ID 格式錯誤：${String(id)}`);
    return n;
  }
  return String(id);
}

/** PostgREST or() 篩選值跳脫 */
function likeTerm(q: string) {
  return q.replace(/[,()*\\%_"]/g, " ").trim();
}

function diff(before: Row | null, after: Row | null) {
  if (!before || !after) return { before, after };
  const b: Row = {};
  const a: Row = {};
  for (const k of Object.keys(after)) {
    if (k === "updated_at" || k === "modified_at") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}

/** 只保留白名單欄位，並做型別轉換（MCP 傳 JSON、後台傳已解析的值） */
export function pick(def: EntityDef, data: Row, opts: { allowReadonly?: boolean } = {}): Row {
  const out: Row = {};
  for (const f of def.fields) {
    if (!(f.name in data)) continue;
    if (f.readonly && !opts.allowReadonly) continue;
    let v = data[f.name];
    if (v === undefined) continue;
    switch (f.type) {
      case "json":
        if (typeof v === "string") {
          try {
            v = v.trim() === "" ? {} : JSON.parse(v);
          } catch {
            throw new AdminError(`${f.label} 不是有效的 JSON`);
          }
        }
        break;
      case "bigints":
        if (typeof v === "string") v = v.split(/[,\s]+/).filter(Boolean).map(Number);
        if (!Array.isArray(v) || v.some((x: unknown) => !Number.isInteger(Number(x)))) throw new AdminError(`${f.label} 必須是整數清單`);
        v = v.map(Number);
        break;
      case "texts":
        if (typeof v === "string") v = v.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(v)) throw new AdminError(`${f.label} 必須是文字清單`);
        break;
      case "number":
      case "money":
      case "media":
      case "term":
        if (v === "" || v === null) v = f.nullable ? null : 0;
        else {
          const n = Number(v);
          if (!Number.isFinite(n)) throw new AdminError(`${f.label} 必須是數字`);
          v = n;
        }
        break;
      case "bool":
        v = v === true || v === "true" || v === "on" || v === "1" || v === 1;
        break;
      case "datetime":
        if (v === "" || v === null) v = null;
        else {
          const d = new Date(String(v));
          if (Number.isNaN(d.getTime())) throw new AdminError(`${f.label} 日期格式錯誤`);
          v = d.toISOString();
        }
        break;
      default:
        if (v === null) v = f.nullable ? null : "";
        else v = String(v);
        if (f.nullable && v === "") v = null;
    }
    out[f.name] = v;
  }
  return out;
}

// ---------- slug ----------

/** 近似 WordPress sanitize_title：小寫、空白轉 -、中文以小寫 percent-encoding 保存 */
export function slugify(s: string): string {
  const base = s
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return encodeURIComponent(base).toLowerCase();
}

function normSlug(s: string) {
  // 使用者輸入的中文 slug → percent-encoded 小寫；已編碼的保持不變
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch {}
  return slugify(decoded);
}

async function uniqueSlug(table: string, slug: string, scope: Row, excludeId?: unknown, col = "slug") {
  const db = serviceDb();
  for (let i = 1; i < 200; i++) {
    const cand = i === 1 ? slug : `${slug}-${i}`;
    let q = db.from(table).select("id").eq(col, cand);
    for (const [k, v] of Object.entries(scope)) q = q.eq(k, v);
    if (excludeId !== undefined) q = q.neq("id", excludeId);
    const { data } = await q.limit(1);
    if (!data?.length) return cand;
  }
  return `${slug}-${Date.now()}`;
}

function normPath(p: string) {
  let s = p.trim();
  try {
    s = decodeURIComponent(s);
  } catch {}
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.includes("?") && !s.endsWith("/")) s += "/";
  return s.normalize("NFC");
}

function effectivePrice(r: Row) {
  const now = Date.now();
  const reg = r.regular_price === null || r.regular_price === undefined || r.regular_price === "" ? null : Number(r.regular_price);
  const sale = r.sale_price === null || r.sale_price === undefined || r.sale_price === "" ? null : Number(r.sale_price);
  const from = r.date_on_sale_from ? new Date(r.date_on_sale_from).getTime() : null;
  const to = r.date_on_sale_to ? new Date(r.date_on_sale_to).getTime() : null;
  const inWindow = (from === null || from <= now) && (to === null || to >= now);
  const onSale = sale !== null && inWindow && (reg === null || sale < reg);
  return { price: onSale ? sale : reg, on_sale: onSale };
}

/** 依庫存數量自動決定庫存狀態（同 WooCommerce） */
function autoStock(r: Row): Row {
  if (!r.manage_stock || r.stock_quantity === null || r.stock_quantity === undefined) return {};
  const q = Number(r.stock_quantity);
  if (q > 0) return { stock_status: "instock" };
  return { stock_status: r.backorders && r.backorders !== "no" ? "onbackorder" : "outofstock" };
}

// ---------- 各資料表的正規化 ----------

async function normalize(def: EntityDef, data: Row, before: Row | null): Promise<Row> {
  const out = { ...data };
  const merged = { ...(before || {}), ...out };
  switch (def.key) {
    case "posts": {
      if (!before && !out.post_type) out.post_type = "post";
      const type = merged.post_type || "post";
      if (out.slug !== undefined || !before) {
        const raw = out.slug ? normSlug(String(out.slug)) : slugify(String(merged.title || "")) || `${type}-${Date.now()}`;
        out.slug = await uniqueSlug("posts", raw, { post_type: type }, before?.id);
      }
      if (type === "page" && (out.slug !== undefined || out.parent_id !== undefined) && !out.path) {
        let prefix = "/";
        const parentId = merged.parent_id;
        if (parentId) {
          const { data: parent } = await serviceDb().from("posts").select("path").eq("id", parentId).maybeSingle();
          if (parent?.path) prefix = parent.path;
        }
        let decoded = String(out.slug ?? merged.slug);
        try {
          decoded = decodeURIComponent(decoded);
        } catch {}
        out.path = `${prefix}${decoded}/`;
      } else if (out.path) out.path = normPath(String(out.path));
      const status = merged.status || "draft";
      if (status === "publish" && !merged.published_at) out.published_at = new Date().toISOString();
      if (status === "future") {
        if (!merged.published_at) throw new AdminError("排程發布需要設定發布時間");
        if (new Date(merged.published_at).getTime() <= Date.now()) out.status = "publish";
      }
      if (before) out.modified_at = new Date().toISOString();
      break;
    }
    case "products": {
      if (out.slug !== undefined || !before) {
        const raw = out.slug ? normSlug(String(out.slug)) : slugify(String(merged.name || "")) || `product-${Date.now()}`;
        out.slug = await uniqueSlug("products", raw, {}, before?.id);
        out.path = `/product/${out.slug}/`;
      }
      if (["regular_price", "sale_price", "date_on_sale_from", "date_on_sale_to"].some((k) => k in out) || !before) {
        Object.assign(out, effectivePrice(merged));
      }
      if (["stock_quantity", "manage_stock", "backorders"].some((k) => k in out)) Object.assign(out, autoStock({ ...merged, ...out }));
      const status = merged.status || "draft";
      if (status === "publish" && !merged.published_at) out.published_at = new Date().toISOString();
      if (status === "future") {
        if (!merged.published_at) throw new AdminError("排程發布需要設定發布時間");
        if (new Date(merged.published_at).getTime() <= Date.now()) out.status = "publish";
      }
      if (before) out.modified_at = new Date().toISOString();
      if (out.sku === "") out.sku = null;
      break;
    }
    case "product_variations": {
      // 變體沒有 on_sale 欄位，只寫入目前售價
      if (["regular_price", "sale_price", "date_on_sale_from", "date_on_sale_to"].some((k) => k in out) || !before) out.price = effectivePrice(merged).price;
      if (["stock_quantity", "manage_stock", "backorders"].some((k) => k in out)) Object.assign(out, autoStock({ ...merged, ...out }));
      break;
    }
    case "terms": {
      if (!before && !out.taxonomy) throw new AdminError("請指定分類法（taxonomy）");
      if (out.slug !== undefined || !before) {
        const raw = out.slug ? normSlug(String(out.slug)) : slugify(String(merged.name || "")) || `term-${Date.now()}`;
        out.slug = await uniqueSlug("terms", raw, { taxonomy: merged.taxonomy }, before?.id);
      }
      if (before && out.parent_id && Number(out.parent_id) === Number(before.id)) throw new AdminError("上層分類不能是自己");
      break;
    }
    case "coupons":
      if (out.code !== undefined) {
        out.code = String(out.code).trim().toLowerCase();
        if (!out.code) throw new AdminError("優惠代碼不可空白");
      }
      break;
    case "discount_rules":
      if (out.slug !== undefined || !before) {
        const raw = out.slug ? normSlug(String(out.slug)) : slugify(String(merged.title || "")) || `rule-${Date.now()}`;
        out.slug = await uniqueSlug("discount_rules", raw, {}, before?.id);
        out.path = `/ywdpd_discount/${out.slug}/`;
      }
      if (before) out.modified_at = new Date().toISOString();
      break;
    case "redirects":
      if (out.source_path !== undefined) out.source_path = normPath(String(out.source_path)).toLowerCase();
      if (out.status_code !== undefined) out.status_code = Number(out.status_code);
      if (!before && !out.target && Number(out.status_code) !== 410) throw new AdminError("請填寫轉址目標");
      break;
    case "menus":
      if (out.slug !== undefined || !before) {
        const raw = out.slug ? normSlug(String(out.slug)) : slugify(String(merged.name || "")) || `menu-${Date.now()}`;
        out.slug = await uniqueSlug("menus", raw, {}, before?.id);
      }
      break;
    case "menu_items":
      if (!before && (!out.title || !out.url)) throw new AdminError("選單項目需要標籤與網址");
      break;
    case "settings":
      if (!before && !out.key) throw new AdminError("請填寫設定鍵");
      if (!before && out.value === undefined) out.value = {};
      break;
  }
  return out;
}

// ---------- 通用 CRUD ----------

export type ListOpts = {
  q?: string | null;
  filters?: Record<string, string | number | boolean | null | undefined>;
  limit?: number;
  offset?: number;
  order?: [string, boolean];
  columns?: string;
};

export async function listRecords(key: string, opts: ListOpts = {}) {
  const def = entityDef(key);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = serviceDb().from(def.table).select(opts.columns || "*", { count: "exact" });
  for (const [k, v] of Object.entries(opts.filters || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (!(def.filters || []).includes(k) && !def.fields.some((f) => f.name === k) && k !== def.pk) continue;
    q = q.eq(k, v);
  }
  const term = opts.q ? likeTerm(opts.q) : "";
  if (term && def.search.length) q = q.or(def.search.map((c) => `${c}.ilike.*${term}*`).join(","));
  const [col, asc] = opts.order || def.order;
  q = q.order(col, { ascending: asc, nullsFirst: false });
  if (col !== def.pk) q = q.order(def.pk, { ascending: false });
  const { data, error, count } = await q.range(offset, offset + limit - 1);
  fail(`讀取${def.label}失敗`, error);
  return { rows: (data || []) as Row[], total: count ?? 0, limit, offset };
}

export async function getRecord(key: string, id: unknown): Promise<Row | null> {
  const def = entityDef(key);
  const { data, error } = await serviceDb().from(def.table).select("*").eq(def.pk, pkValue(def, id)).maybeSingle();
  fail(`讀取${def.label}失敗`, error);
  return data as Row | null;
}

export async function createRecord(key: string, data: Row, actor: Actor, opts: { trusted?: boolean } = {}) {
  const def = entityDef(key);
  if (def.readonly) throw new AdminError(`${def.label} 為唯讀`);
  const clean = opts.trusted ? data : pick(def, data);
  if (def.key === "settings" && data.key) clean.key = String(data.key);
  const row = await normalize(def, clean, null);
  const { data: created, error } = await serviceDb().from(def.table).insert(row).select("*").single();
  fail(`新增${def.label}失敗`, error);
  await audit(actor, "create", def.key, created[def.pk], null, created);
  if (def.revalidate) refreshSite();
  return created as Row;
}

export async function updateRecord(key: string, id: unknown, patch: Row, actor: Actor, opts: { action?: string } = {}) {
  const def = entityDef(key);
  if (def.readonly) throw new AdminError(`${def.label} 為唯讀`);
  const before = await getRecord(key, id);
  if (!before) throw new AdminError(`找不到${def.label} #${String(id)}`);
  const clean = pick(def, patch);
  if (def.key === "settings") delete clean.key;
  const row = await normalize(def, clean, before);
  if (!Object.keys(row).length) return before;
  const { data: after, error } = await serviceDb().from(def.table).update(row).eq(def.pk, pkValue(def, id)).select("*").single();
  fail(`更新${def.label}失敗`, error);
  const d = diff(before, after as Row);
  await audit(actor, opts.action || "update", def.key, id, d.before, d.after);
  if (def.revalidate) refreshSite();
  return after as Row;
}

export async function deleteRecord(key: string, id: unknown, actor: Actor, opts: { force?: boolean } = {}) {
  const def = entityDef(key);
  if (def.readonly) throw new AdminError(`${def.label} 為唯讀`);
  if (def.key === "media") return deleteMedia(Number(id), actor);
  const before = await getRecord(key, id);
  if (!before) throw new AdminError(`找不到${def.label} #${String(id)}`);
  if (def.softDelete && !opts.force && before.status !== "trash") {
    const { error } = await serviceDb().from(def.table).update({ status: "trash", meta: { ...(before.meta || {}), _wp_trash_meta_status: before.status } }).eq(def.pk, pkValue(def, id));
    fail(`刪除${def.label}失敗`, error);
    await audit(actor, "trash", def.key, id, { status: before.status }, { status: "trash" });
    if (def.revalidate) refreshSite();
    return { trashed: true, deleted: false, id };
  }
  const { error } = await serviceDb().from(def.table).delete().eq(def.pk, pkValue(def, id));
  fail(`刪除${def.label}失敗`, error);
  await audit(actor, "delete", def.key, id, before, null);
  if (def.revalidate) refreshSite();
  return { trashed: false, deleted: true, id };
}

/** 從垃圾桶還原（恢復原狀態，預設草稿） */
export async function restoreRecord(key: "posts" | "products", id: unknown, actor: Actor) {
  const before = await getRecord(key, id);
  if (!before) throw new AdminError("找不到資料");
  const status = (before.meta?._wp_trash_meta_status as string) || "draft";
  return updateRecord(key, id, { status: status === "trash" ? "draft" : status }, actor, { action: "restore" });
}

// ---------- 分類關聯 ----------

async function recountTerms(termIds: number[]) {
  const db = serviceDb();
  for (const id of new Set(termIds)) {
    const [{ count: pc }, { count: tc }] = await Promise.all([
      db.from("product_terms").select("product_id", { count: "exact", head: true }).eq("term_id", id),
      db.from("post_terms").select("post_id", { count: "exact", head: true }).eq("term_id", id),
    ]);
    await db.from("terms").update({ count: (pc || 0) + (tc || 0) }).eq("id", id);
  }
}

export async function setObjectTerms(kind: "product" | "post", objectId: number, termIds: number[], actor: Actor, taxonomies?: string[]) {
  const db = serviceDb();
  const table = kind === "product" ? "product_terms" : "post_terms";
  const col = kind === "product" ? "product_id" : "post_id";
  const ids = [...new Set(termIds.map(Number).filter(Number.isInteger))];
  const { data: terms } = await db.from("terms").select("id,taxonomy").in("id", ids.length ? ids : [-1]);
  if ((terms || []).length !== ids.length) throw new AdminError("有分類 ID 不存在");
  const { data: current } = await db.from(table).select("term_id, terms(taxonomy)").eq(col, objectId);
  const scoped = (current || []).filter((r: any) => !taxonomies || taxonomies.includes(r.terms?.taxonomy));
  const beforeIds = scoped.map((r: any) => Number(r.term_id));
  if (beforeIds.length) {
    const { error } = await db.from(table).delete().eq(col, objectId).in("term_id", beforeIds);
    fail("更新分類失敗", error);
  }
  if (ids.length) {
    const { error } = await db.from(table).insert(ids.map((term_id, i) => ({ [col]: objectId, term_id, term_order: i })));
    fail("更新分類失敗", error);
  }
  await recountTerms([...beforeIds, ...ids]);
  await audit(actor, "set_terms", kind === "product" ? "products" : "posts", objectId, { term_ids: beforeIds }, { term_ids: ids });
  refreshSite();
  return ids;
}

export async function setProductImages(productId: number, mediaIds: number[], actor: Actor) {
  const db = serviceDb();
  const ids = [...new Set(mediaIds.map(Number).filter(Number.isInteger))];
  const { data: exist } = await db.from("media").select("id").in("id", ids.length ? ids : [-1]);
  if ((exist || []).length !== ids.length) throw new AdminError("有媒體 ID 不存在");
  const { data: before } = await db.from("product_images").select("media_id,position").eq("product_id", productId).order("position");
  await db.from("product_images").delete().eq("product_id", productId);
  if (ids.length) {
    const { error } = await db.from("product_images").insert(ids.map((media_id, position) => ({ product_id: productId, media_id, position })));
    fail("更新商品圖片失敗", error);
  }
  await db.from("products").update({ featured_media_id: ids[0] ?? null }).eq("id", productId);
  await audit(actor, "set_images", "products", productId, { media_ids: (before || []).map((r) => r.media_id) }, { media_ids: ids });
  refreshSite();
  return ids;
}

// ---------- 價格與庫存 ----------

export async function setPrice(
  target: { product_id: number; variation_id?: number | null },
  p: { regular_price?: number | null; sale_price?: number | null; date_on_sale_from?: string | null; date_on_sale_to?: string | null },
  actor: Actor,
) {
  const key = target.variation_id ? "product_variations" : "products";
  const id = target.variation_id || target.product_id;
  if (target.variation_id) {
    const v = await getRecord("product_variations", target.variation_id);
    if (!v || Number(v.product_id) !== Number(target.product_id)) throw new AdminError("變體不屬於該商品");
  }
  return updateRecord(key, id, p, actor, { action: "set_price" });
}

export async function adjustStock(
  target: { product_id: number; variation_id?: number | null },
  p: { set?: number | null; delta?: number | null; stock_status?: string | null; manage_stock?: boolean | null },
  actor: Actor,
) {
  const key = target.variation_id ? "product_variations" : "products";
  const id = target.variation_id || target.product_id;
  const cur = await getRecord(key, id);
  if (!cur) throw new AdminError("找不到商品／變體");
  if (target.variation_id && Number(cur.product_id) !== Number(target.product_id)) throw new AdminError("變體不屬於該商品");
  const patch: Row = {};
  if (p.manage_stock !== undefined && p.manage_stock !== null) patch.manage_stock = p.manage_stock;
  if (p.set !== undefined && p.set !== null) {
    patch.stock_quantity = Math.trunc(p.set);
    patch.manage_stock = true;
  } else if (p.delta) {
    patch.stock_quantity = Math.trunc(Number(cur.stock_quantity || 0) + Number(p.delta));
    patch.manage_stock = true;
  }
  if (p.stock_status) {
    if (!["instock", "outofstock", "onbackorder"].includes(p.stock_status)) throw new AdminError("stock_status 只能是 instock / outofstock / onbackorder");
    patch.stock_status = p.stock_status;
  }
  return updateRecord(key, id, patch, actor, { action: "adjust_stock" });
}

// ---------- 組合讀取 ----------

export async function getProductFull(id: number): Promise<Row | null> {
  const db = serviceDb();
  const product = await getRecord("products", id);
  if (!product) return null;
  const [imgs, terms, variations, attributes] = await Promise.all([
    db.from("product_images").select("position, media(id,title,alt_text,public_url,mime_type)").eq("product_id", id).order("position"),
    db.from("product_terms").select("term_order, terms(id,taxonomy,name,slug)").eq("product_id", id).order("term_order"),
    db.from("product_variations").select("*").eq("product_id", id).order("menu_order"),
    db.from("product_attributes").select("*").eq("product_id", id).order("position"),
  ]);
  return {
    ...product,
    images: (imgs.data || []).map((r: any) => ({ position: r.position, ...r.media })),
    terms: (terms.data || []).map((r: any) => r.terms),
    variations: variations.data || [],
    attributes: attributes.data || [],
  };
}

export async function getPostFull(id: number): Promise<Row | null> {
  const db = serviceDb();
  const post = await getRecord("posts", id);
  if (!post) return null;
  const { data: terms } = await db.from("post_terms").select("terms(id,taxonomy,name,slug)").eq("post_id", id).order("term_order");
  return { ...post, terms: (terms || []).map((r: any) => r.terms) };
}

export async function getOrderFull(id: number): Promise<Row | null> {
  const db = serviceDb();
  const order = await getRecord("orders", id);
  if (!order) return null;
  const [items, notes, refunds] = await Promise.all([
    db.from("order_items").select("*").eq("order_id", id).order("id"),
    db.from("order_notes").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    db.from("orders").select("id,total,date_created,meta").eq("parent_id", id).eq("type", "shop_order_refund"),
  ]);
  return { ...order, items: items.data || [], notes: notes.data || [], refunds: refunds.data || [] };
}

// ---------- 訂單 ----------

export async function addOrderNote(orderId: number, note: string, actor: Actor, isCustomerNote = false) {
  const text = note.trim();
  if (!text) throw new AdminError("備註不可空白");
  const { data, error } = await serviceDb()
    .from("order_notes")
    .insert({ order_id: orderId, note: text, is_customer_note: isCustomerNote, added_by: actor.email || actor.type })
    .select("*")
    .single();
  fail("新增訂單備註失敗", error);
  await audit(actor, "add_note", "orders", orderId, null, { note: text, is_customer_note: isCustomerNote });
  return data;
}

export async function updateOrderStatus(orderId: number, status: string, actor: Actor, note?: string | null) {
  if (!ORDER_STATUS_LABEL[status]) throw new AdminError(`不支援的訂單狀態：${status}`);
  const before = await getRecord("orders", orderId);
  if (!before) throw new AdminError(`找不到訂單 #${orderId}`);
  if (before.status === status) {
    if (note) await addOrderNote(orderId, note, actor);
    return before;
  }
  const now = new Date().toISOString();
  const patch: Row = { status };
  if (status === "completed" && !before.date_completed) patch.date_completed = now;
  if ((status === "processing" || status === "completed") && !before.date_paid) patch.date_paid = now;
  const { data: after, error } = await serviceDb().from("orders").update(patch).eq("id", orderId).select("*").single();
  fail("更新訂單狀態失敗", error);
  await serviceDb()
    .from("order_notes")
    .insert({
      order_id: orderId,
      note: `訂單狀態從 ${ORDER_STATUS_LABEL[before.status] || before.status} 變更為 ${ORDER_STATUS_LABEL[status]}。${note ? ` ${note}` : ""}`,
      added_by: actor.email || actor.type,
    });
  await audit(actor, "status_change", "orders", orderId, { status: before.status }, { status, note: note || null });
  return after;
}

// ---------- 網站設定 ----------

export async function getSettings(key?: string | null) {
  let q = serviceDb().from("settings").select("key,value,is_public,source,updated_at").order("key");
  if (key) q = q.eq("key", key);
  const { data, error } = await q;
  fail("讀取設定失敗", error);
  return data || [];
}

export async function setSetting(key: string, value: unknown, actor: Actor, isPublic?: boolean) {
  if (!/^[a-z0-9_]{1,64}$/.test(key)) throw new AdminError("設定鍵只能用小寫英數與底線");
  if (key === "private_data_pending") throw new AdminError("此設定由資料匯入流程維護");
  const db = serviceDb();
  const { data: before } = await db.from("settings").select("*").eq("key", key).maybeSingle();
  const row: Row = { key, value, source: "admin" };
  if (isPublic !== undefined) row.is_public = isPublic;
  else if (!before) row.is_public = true;
  const { data: after, error } = await db.from("settings").upsert(row, { onConflict: "key" }).select("*").single();
  fail("儲存設定失敗", error);
  await audit(actor, before ? "update" : "create", "settings", key, before ? { value: before.value } : null, { value });
  refreshSite();
  return after;
}

// ---------- 媒體 ----------

const RASTER = /^image\/(jpeg|jpg|png|webp|avif|tiff|heic|heif|bmp)$/;
const PASSTHROUGH = /^(image\/gif|image\/svg\+xml|application\/pdf|video\/(mp4|webm|quicktime|ogg))$/;
const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

const VARIANT_WIDTHS = [480, 960, 1440];

export async function uploadMedia(
  input: { filename: string; bytes: Buffer; mime?: string | null; title?: string | null; alt_text?: string | null; caption?: string | null; parent_post_id?: number | null },
  actor: Actor,
) {
  const dot = input.filename.lastIndexOf(".");
  const ext = dot >= 0 ? input.filename.slice(dot).toLowerCase() : "";
  const rawBase = dot >= 0 ? input.filename.slice(0, dot) : input.filename;
  let mime = (input.mime || "").toLowerCase();
  if (!mime || mime === "application/octet-stream") mime = EXT_MIME[ext] || "";
  if (!input.bytes.length) throw new AdminError("檔案是空的");
  if (input.bytes.length > 50 * 1024 * 1024) throw new AdminError("檔案超過 50MB");

  let out = input.bytes;
  let outMime = mime;
  let outExt = ext || "";
  let width: number | null = null;
  let height: number | null = null;
  if (RASTER.test(mime)) {
    const { data, info } = await sharp(input.bytes, { failOn: "none" })
      .rotate()
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    out = data;
    outMime = "image/webp";
    outExt = ".webp";
    width = info.width;
    height = info.height;
  } else if (PASSTHROUGH.test(mime)) {
    if (mime === "image/gif" || mime === "image/svg+xml") {
      try {
        const m = await sharp(input.bytes, { failOn: "none" }).metadata();
        width = m.width ?? null;
        height = m.pageHeight ?? m.height ?? null;
      } catch {}
    }
    if (!outExt) outExt = Object.entries(EXT_MIME).find(([, v]) => v === mime)?.[0] || "";
  } else {
    throw new AdminError(`不支援的檔案類型：${mime || ext || "未知"}（可上傳圖片、GIF、SVG、PDF、影片）`);
  }

  const db = serviceDb();
  const sha1 = createHash("sha1").update(out).digest("hex");
  // 同內容已存在 → 不重複上傳（Gather 空間有限）
  const { data: dup } = await db.from("media").select("*").eq("sha1", sha1).not("storage_path", "is", null).is("canonical_media_id", null).limit(1);
  if (dup?.length) return { ...dup[0], duplicate: true };

  const base =
    rawBase
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 80) || "file";
  const d = new Date();
  const ym = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  let key = "";
  let uploaded = false;
  for (let i = 0; i < 50 && !uploaded; i++) {
    key = `uploads/${ym}/${base}${i ? `-${i}` : ""}${outExt}`;
    const { data: taken } = await db.from("media").select("id").eq("storage_path", key).limit(1);
    if (taken?.length) continue;
    const { error } = await db.storage.from(BUCKET).upload(key, out, { contentType: outMime, upsert: false, cacheControl: "31536000" });
    if (!error) uploaded = true;
    else if (!/exist|duplicate/i.test(error.message)) throw new AdminError(`上傳失敗：${error.message}`);
  }
  if (!uploaded) throw new AdminError("無法產生不重複的檔名");
  const publicUrl = db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  // 響應式變體（寬 480/960/1440，q75，不放大）：v/<寬>/<路徑>.webp
  const variants: { w: number; h: number; path: string; url: string; bytes: number }[] = [];
  if (outMime === "image/webp" && RASTER.test(mime) && width) {
    for (const w of VARIANT_WIDTHS) {
      if (w >= width) continue;
      try {
        const v = await sharp(out).resize({ width: w, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer({ resolveWithObject: true });
        const vKey = `v/${w}/${key.replace(/^uploads\//, "")}`;
        const { error: ve } = await db.storage.from(BUCKET).upload(vKey, v.data, { contentType: "image/webp", upsert: true, cacheControl: "31536000, immutable" });
        if (!ve) variants.push({ w: v.info.width, h: v.info.height, path: vKey, url: db.storage.from(BUCKET).getPublicUrl(vKey).data.publicUrl, bytes: v.data.length });
      } catch {
        // 變體失敗不影響原圖上傳；前台會退回原圖
      }
    }
  }
  const { data: row, error } = await db
    .from("media")
    .insert({
      slug: base,
      title: input.title || rawBase,
      alt_text: input.alt_text || null,
      caption: input.caption || null,
      mime_type: outMime,
      original_path: key.replace(/^uploads\//, ""),
      old_url: publicUrl,
      storage_path: key,
      public_url: publicUrl,
      width,
      height,
      bytes: out.length,
      original_bytes: input.bytes.length,
      sha1,
      parent_post_id: input.parent_post_id || null,
      status: "publish",
      source: "admin_upload",
      variants,
    })
    .select("*")
    .single();
  if (error) {
    await db.storage.from(BUCKET).remove([key, ...variants.map((v) => v.path)]);
    throw new AdminError(`寫入媒體庫失敗：${error.message}`);
  }
  await audit(actor, "upload", "media", row.id, null, { storage_path: key, mime_type: outMime, bytes: out.length, original_bytes: input.bytes.length });
  refreshSite();
  return row as Row;
}

export async function deleteMedia(id: number, actor: Actor) {
  const db = serviceDb();
  const before = await getRecord("media", id);
  if (!before) throw new AdminError(`找不到媒體 #${id}`);
  const { data: shared } = await db.from("media").select("id").eq("storage_path", before.storage_path || "__none__").neq("id", id).limit(1);
  const { data: canon } = await db.from("media").select("id").eq("canonical_media_id", id).limit(1);
  if (canon?.length) throw new AdminError("有其他媒體指向此檔案（重複檔），請先刪除那些項目");
  const { error } = await db.from("media").delete().eq("id", id);
  fail("刪除媒體失敗", error);
  let removedFile = false;
  if (before.storage_path && !shared?.length) {
    const vPaths = (Array.isArray(before.variants) ? before.variants : []).map((v: Row) => String(v.path || "")).filter((x: string) => x.startsWith("v/"));
    const { error: e2 } = await db.storage.from(BUCKET).remove([before.storage_path, ...vPaths]);
    removedFile = !e2;
  }
  await audit(actor, "delete", "media", id, before, { removed_file: removedFile });
  refreshSite();
  return { deleted: true, id, removed_file: removedFile };
}
