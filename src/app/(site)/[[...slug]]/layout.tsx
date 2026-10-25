import type { Metadata, Viewport } from "next";
import { SiteShell, siteMetadata, siteViewport } from "@/app/_site/shell";
import { ctxFor, pathFromSlug } from "@/lib/route";

// 公開頁：ISR（5 分鐘），後台／MCP 寫入後以 revalidateTag('site') + revalidatePath('/', 'layout') 立即更新
export const revalidate = 300;
export const dynamicParams = true;

export const metadata: Metadata = siteMetadata;
export const viewport: Viewport = siteViewport;

export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const sc = await ctxFor(pathFromSlug(slug), "");
  return (
    <SiteShell sc={sc} mode="static">
      {children}
    </SiteShell>
  );
}
