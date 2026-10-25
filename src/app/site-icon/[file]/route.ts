import sharp from "sharp";
import { getSite, mapUrl } from "@/lib/data";

// 網站圖示：從 bucket 取一次、縮成 32/180/192 PNG，交給 Vercel CDN 快取（避免每次瀏覽都向 Supabase 拉 512px 原圖）
const SIZES = new Set([32, 180, 192]);

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const size = Number((file.match(/^(\d+)\.png$/) || [])[1]);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  const site = await getSite();
  const src = site.settings.site_icon?.url || mapUrl(site, "https://go.palacetwshop.com/wp-content/uploads/2024/12/cropped-favicon-32x32.png");
  const r = await fetch(src);
  if (!r.ok) return new Response("Not found", { status: 404 });
  const png = await sharp(Buffer.from(await r.arrayBuffer())).resize(size, size, { fit: "cover" }).png().toBuffer();
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400" },
  });
}
