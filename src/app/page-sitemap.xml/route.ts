import { pageSitemap, xml } from "@/lib/sitemap";
export const dynamic = "force-dynamic";
export async function GET() {
  return xml(await pageSitemap());
}
