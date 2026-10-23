import "server-only";
import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "./env";
import type { Seo, Site } from "./data";
import type { Ctx, ReqInfo } from "./route";
import { archiveData, productUrl, termUrl } from "@/theme/render";
import { stripTags, decodeEntities } from "@/theme/util";

function abs(path: string) {
  if (!path) return SITE_URL + "/";
  if (/^https?:\/\//.test(path)) return path;
  return SITE_URL + (path.startsWith("/") ? path : "/" + path);
}

function absolutize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(absolutize);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && x.startsWith("/") && ["@id", "url", "item", "target"].includes(k)) o[k] = abs(x);
      else o[k] = absolutize(x);
    }
    return o;
  }
  return v;
}

export type SeoOut = { meta: Metadata; jsonLd: unknown | null; ogProperties?: Record<string, string> };

function build(seo: Seo, canonical: string, extra: { prev?: string; next?: string; titleOverride?: string; other?: Record<string, string> } = {}): SeoOut {
  const title = decodeEntities(extra.titleOverride || seo.title || SITE_NAME);
  const desc = seo.description ? decodeEntities(seo.description) : undefined;
  const ogTitle = decodeEntities(extra.titleOverride || seo.og_title || title);
  const meta: Metadata = {
    title: { absolute: title },
    description: desc,
    robots: seo.robots || undefined,
    alternates: { canonical: abs(canonical) },
    openGraph: {
      locale: "zh_TW",
      ...(seo.og_type === "product" ? {} : { type: (seo.og_type === "article" ? "article" : "website") as "website" | "article" }),
      title: ogTitle,
      description: seo.og_description ? decodeEntities(seo.og_description) : desc,
      url: abs(canonical),
      siteName: SITE_NAME,
      images: seo.og_image ? [{ url: seo.og_image }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description: desc,
      images: seo.og_image ? [seo.og_image] : undefined,
    },
    other: { ...(extra.other || {}) },
  };
  if (extra.prev || extra.next) {
    meta.other = { ...(meta.other || {}) };
  }
  return { meta, jsonLd: seo.schema ? absolutize(seo.schema) : null };
}

export function seoFor(site: Site, ctx: Ctx, req: ReqInfo): SeoOut & { prev?: string; next?: string } {
  const home = site.posts.find((p) => p.id === site.settings.reading?.page_on_front);
  const homeSeo = (home?.seo || {}) as Seo;
  switch (ctx.kind) {
    case "shop": {
      const d = archiveData(site, ctx);
      const canonical = ctx.page > 1 ? `/page/${ctx.page}/` : "/";
      const out = build(homeSeo, canonical);
      return { ...out, prev: ctx.page > 1 ? abs(ctx.page === 2 ? "/" : `/page/${ctx.page - 1}/`) : undefined, next: ctx.page < d.pages ? abs(`/page/${ctx.page + 1}/`) : undefined };
    }
    case "product_cat":
    case "product_tag": {
      const d = archiveData(site, ctx);
      const base = termUrl(ctx.term);
      const canonical = ctx.page > 1 ? `${base}page/${ctx.page}/` : base;
      const seo = { ...(ctx.term.seo || {}) } as Seo;
      const t = ctx.page > 1 ? `${ctx.term.name} 彙整 - Page ${ctx.page} of ${d.pages} - ${SITE_NAME}` : undefined;
      const out = build(seo, canonical, { titleOverride: t });
      return { ...out, prev: ctx.page > 1 ? abs(ctx.page === 2 ? base : `${base}page/${ctx.page - 1}/`) : undefined, next: ctx.page < d.pages ? abs(`${base}page/${ctx.page + 1}/`) : undefined };
    }
    case "category":
    case "post_tag":
      return build(ctx.term.seo || {}, termUrl(ctx.term));
    case "blog":
    case "page":
    case "ct_content_block": {
      const seo = ctx.post.seo || {};
      let canonical = seo.canonical_path || ctx.post.path || "/";
      if (ctx.kind === "page" && ctx.special && ctx.sub?.length) canonical = (ctx.post.path || "/") + ctx.sub.join("/") + "/";
      return build(seo, canonical);
    }
    case "product": {
      const p = ctx.product;
      const out = build(p.seo || {}, p.seo?.canonical_path || productUrl(p));
      // Rank Math 的商品 OG 屬性（property=，Next metadata 無法輸出，交給頁面以 <meta property> 輸出）
      out.ogProperties = {
        "og:type": "product",
        "product:price:amount": String(Number(p.price || 0)),
        "product:price:currency": "TWD",
        ...(p.stock_status === "instock" ? { "product:availability": "instock" } : {}),
      };
      return out;
    }
    case "search": {
      // Rank Math：搜尋頁不輸出 canonical，og:url 為 /search/<詞>/
      const out = build({ title: `您正在找 ${ctx.s} - ${SITE_NAME}`, robots: "follow, noindex", og_type: "article" }, `/search/${encodeURIComponent(ctx.s)}/`);
      out.meta.alternates = undefined;
      return out;
    }
    default:
      return build({ title: `找不到頁面 - ${SITE_NAME}`, robots: "noindex, follow" }, req.pathname);
  }
}

export function metaDescriptionFromHtml(html: string) {
  return stripTags(html).slice(0, 160);
}
