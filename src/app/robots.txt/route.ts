import { SITE_URL } from "@/lib/env";
export const dynamic = "force-dynamic";
// 與舊站 robots.txt 相同（WooCommerce + Rank Math），另加新站 API 路徑
export async function GET() {
  const body = `User-agent: *
Disallow: /wp-content/uploads/wc-logs/
Disallow: /wp-content/uploads/woocommerce_transient_files/
Disallow: /wp-content/uploads/woocommerce_uploads/
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
Disallow: /api/

Sitemap: ${SITE_URL}/sitemap_index.xml
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=UTF-8" } });
}
