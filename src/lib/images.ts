import type { Media, Site } from "./data";

/**
 * 響應式圖片：把 HTML 內所有指向本站 bucket 原圖的 <img> 改寫成 srcset/sizes，
 * 並補齊 width/height、loading="lazy"（首屏主圖除外）、decoding="async"。
 * 變體由 scripts/media/variants.mjs 或後台上傳產生（v/<寬>/<路徑>.webp，寬 480/960/1440）。
 */

export type Variant = { w: number; h: number; url: string; path?: string; bytes?: number };
type Info = { w: number | null; h: number | null; variants: Variant[]; src: string };

const indexCache = new WeakMap<Site, Map<string, Info>>();

function index(site: Site): Map<string, Info> {
  let map = indexCache.get(site);
  if (map) return map;
  map = new Map();
  for (const m of site.media) {
    if (!m.public_url) continue;
    const variants = (Array.isArray(m.variants) ? m.variants : []).filter((v) => v && v.url && v.w > 0).sort((a, b) => a.w - b.w);
    const prev = map.get(m.public_url);
    // 重複檔（canonical_media_id）共用同一網址：以有變體的那筆為準
    if (prev && prev.variants.length >= variants.length) continue;
    map.set(m.public_url, { w: m.width, h: m.height, variants, src: m.public_url });
  }
  indexCache.set(site, map);
  return map;
}

function srcsetOf(info: Info): string {
  const parts = info.variants.map((v) => `${v.url} ${v.w}w`);
  if (info.w && !info.variants.some((v) => v.w === info.w)) parts.push(`${info.src} ${info.w}w`);
  return parts.join(", ");
}

/** 單張媒體的 srcset（無變體時回傳空字串） */
export function mediaSrcset(site: Site, m: Media | undefined | null): string {
  if (!m?.public_url) return "";
  const info = index(site).get(m.public_url);
  return info && info.variants.length ? srcsetOf(info) : "";
}

/** CSS 背景圖：寬於 1440 的原圖改用 1440 變體 */
export function bgUrl(site: Site, url: string): string {
  const info = index(site).get(url);
  const v = info?.variants.find((x) => x.w === 1440);
  return v ? v.url : url;
}

const ATTR = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");

function getAttr(tag: string, name: string): string | null {
  const m = tag.match(ATTR(name));
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
}
function dropAttr(tag: string, name: string): string {
  return tag.replace(new RegExp(ATTR(name).source, "gi"), "");
}
function addAttr(tag: string, attr: string): string {
  return tag.replace(/\s*\/?>$/, (end) => ` ${attr}${end.includes("/") ? " />" : ">"}`);
}
function unesc(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&#038;/g, "&");
}

const BUCKET_MARK = "/storage/v1/object/public/site-gopalacetw/";

export function responsiveImg(site: Site, tag: string): string {
  const raw = getAttr(tag, "src");
  if (!raw) return tag;
  const src = unesc(raw);
  let out = tag;
  const info = index(site).get(src);
  if (info) {
    if (info.variants.length) {
      out = dropAttr(out, "srcset");
      out = dropAttr(out, "data-srcset");
      out = addAttr(out, `srcset="${srcsetOf(info)}"`);
      if (!getAttr(out, "sizes")) {
        const dispW = Number(getAttr(out, "width")) || info.w || 0;
        out = addAttr(out, dispW ? `sizes="(max-width: ${dispW}px) 100vw, ${dispW}px"` : `sizes="100vw"`);
      }
    }
    if (!getAttr(out, "width") && !getAttr(out, "height") && info.w && info.h) out = addAttr(out, `width="${info.w}" height="${info.h}"`);
  } else if (!src.includes(BUCKET_MARK)) {
    return tag; // 外站圖片、主題內建圖示：不動
  }
  const eager = getAttr(out, "fetchpriority") === "high" || getAttr(out, "loading") === "eager";
  if (!eager && !getAttr(out, "loading")) out = addAttr(out, `loading="lazy"`);
  // 延遲載入的圖：sizes 前加 auto，支援的瀏覽器（Chrome 126+）依實際版面寬度挑變體，其餘瀏覽器用後面的估計值
  const sizes = getAttr(out, "sizes");
  if (sizes && !eager && getAttr(out, "loading") === "lazy" && !/^\s*auto\b/.test(sizes) && getAttr(out, "srcset")) {
    out = out.replace(ATTR("sizes"), ` sizes="auto, ${sizes}"`);
  }
  if (!getAttr(out, "decoding")) out = addAttr(out, `decoding="async"`);
  return out;
}

/** 改寫整段 HTML：<img> → srcset；inline style / <style> 內的背景圖原檔 → 1440 變體 */
export function responsiveHtml(site: Site, html: string): string {
  if (!html || !html.includes(BUCKET_MARK)) return html;
  let out = html.replace(/<img\b[^>]*>/gi, (tag) => responsiveImg(site, tag));
  out = out.replace(/url\(\s*(['"]?)(https:\/\/[^'")\s]+)\1\s*\)/g, (all, q: string, u: string) => {
    if (!u.includes(BUCKET_MARK)) return all;
    const v = bgUrl(site, unesc(u));
    return v === unesc(u) ? all : `url(${q}${v}${q})`;
  });
  return out;
}
