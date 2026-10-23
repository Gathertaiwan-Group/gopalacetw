import { SITE_URL, SITE_NAME } from "@/lib/env";
import { getSite } from "@/lib/data";
import { encPath, esc, stripTags } from "@/theme/util";

export const dynamic = "force-dynamic";

/** 舊站 /feed/：文章 RSS（目前 0 篇文章，僅頻道資訊） */
export async function GET() {
  const site = await getSite();
  const posts = site.posts.filter((p) => p.post_type === "post" && p.status === "publish").sort((a, b) => (b.published_at || "").localeCompare(a.published_at || "")).slice(0, 10);
  const icon = site.settings.site_icon?.url || "";
  const last = posts[0]?.modified_at || site.products.map((p) => p.modified_at || "").sort().pop() || new Date().toISOString();
  const items = posts
    .map(
      (p) => `	<item>
		<title>${esc(stripTags(p.title))}</title>
		<link>${SITE_URL}${encPath(p.path || "/")}</link>
		<pubDate>${new Date(p.published_at || Date.now()).toUTCString().replace("GMT", "+0000")}</pubDate>
		<guid isPermaLink="false">${SITE_URL}/?p=${p.id}</guid>
		<description><![CDATA[${stripTags(p.excerpt || p.content).slice(0, 200)}]]></description>
	</item>`,
    )
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:wfw="http://wellformedweb.org/CommentAPI/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:atom="http://www.w3.org/2005/Atom"
	xmlns:sy="http://purl.org/rss/1.0/modules/syndication/"
	xmlns:slash="http://purl.org/rss/1.0/modules/slash/"
	>

<channel>
	<title>${SITE_NAME}</title>
	<atom:link href="${SITE_URL}/feed/" rel="self" type="application/rss+xml" />
	<link>${SITE_URL}</link>
	<description></description>
	<lastBuildDate>${new Date(last).toUTCString().replace("GMT", "+0000")}</lastBuildDate>
	<language>zh-TW</language>
	<sy:updatePeriod>
	hourly	</sy:updatePeriod>
	<sy:updateFrequency>
	1	</sy:updateFrequency>
	

<image>
	<url>${esc(icon)}</url>
	<title>${SITE_NAME}</title>
	<link>${SITE_URL}</link>
	<width>32</width>
	<height>32</height>
</image> 
${items}
</channel>
</rss>
`;
  return new Response(body, { headers: { "content-type": "application/rss+xml; charset=UTF-8" } });
}
