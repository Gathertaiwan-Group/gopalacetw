import { sitemapIndex, xml } from "@/lib/sitemap";
export const dynamic = "force-dynamic";
export async function GET() {
  return xml(await sitemapIndex());
}
