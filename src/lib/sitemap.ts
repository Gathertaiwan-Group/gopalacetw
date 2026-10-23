import "server-only";
import { SITE_URL } from "./env";
import { getSite, visibleInCatalog } from "./data";
import { encPath } from "@/theme/util";
import { productUrl } from "@/theme/render";

const XSL = ""; // 舊站 Rank Math 使用 main-sitemap.xsl；新站輸出純 XML

function lastmod(d: string | null | undefined) {
  if (!d) return "";
  return `\n\t\t<lastmod>${new Date(d).toISOString().replace(/\.\d+Z$/, "+00:00")}</lastmod>`;
}

export async function sitemapIndex() {
  const site = await getSite();
  const pages = site.posts.filter((p) => p.post_type === "page" && p.status === "publish");
  const prods = site.products.filter(visibleInCatalog);
  const max = (xs: (string | null)[]) => xs.filter(Boolean).sort().pop() || null;
  return `<?xml version="1.0" encoding="UTF-8"?>${XSL}
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<sitemap>
		<loc>${SITE_URL}/page-sitemap.xml</loc>${lastmod(max(pages.map((p) => p.modified_at)))}
	</sitemap>
	<sitemap>
		<loc>${SITE_URL}/product-sitemap.xml</loc>${lastmod(max(prods.map((p) => p.modified_at)))}
	</sitemap>
</sitemapindex>`;
}

function urlset(rows: { loc: string; mod: string | null; images?: string[] }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>${XSL}
<urlset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd http://www.google.com/schemas/sitemap-image/1.1 http://www.google.com/schemas/sitemap-image/1.1/sitemap-image.xsd" xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows
  .map(
    (r) => `	<url>
		<loc>${r.loc}</loc>${lastmod(r.mod)}${(r.images || []).map((i) => `\n\t\t<image:image>\n\t\t\t<image:loc>${i}</image:loc>\n\t\t</image:image>`).join("")}
	</url>`,
  )
  .join("\n")}
</urlset>`;
}

export async function pageSitemap() {
  const site = await getSite();
  // 舊站 page-sitemap：首頁、完售、home01、home-2、my-account-2、cart-2、checkout-2（blog-2 為文章頁，不列）
  const blogId = site.settings.reading?.page_for_posts;
  const pages = site.posts
    .filter((p) => p.post_type === "page" && p.status === "publish" && p.id !== blogId && !String(p.seo?.robots || "").includes("noindex") || (p.post_type === "page" && ["cart-2", "checkout-2", "my-account-2"].includes(p.slug)))
    .sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : (b.modified_at || "").localeCompare(a.modified_at || "")));
  return urlset(pages.map((p) => ({ loc: SITE_URL + encPath(p.path || "/"), mod: p.modified_at })));
}

export async function productSitemap() {
  const site = await getSite();
  const prods = site.products.filter(visibleInCatalog).sort((a, b) => (b.modified_at || "").localeCompare(a.modified_at || ""));
  return urlset(prods.map((p) => ({ loc: SITE_URL + productUrl(p), mod: p.modified_at, images: p.images.map((m) => m.public_url || "").filter(Boolean) })));
}

export function xml(body: string) {
  return new Response(body, { headers: { "content-type": "application/xml; charset=UTF-8", "x-robots-tag": "noindex, follow", "cache-control": "public, max-age=0, s-maxage=600" } });
}
