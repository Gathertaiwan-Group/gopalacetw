import type { Metadata, Viewport } from "next";
import { SiteShell, siteMetadata, siteViewport } from "@/app/_site/shell";
import { getCtx } from "@/lib/route";

// 動態前台：購物車／結帳／會員／搜尋／商品篩選／草稿預覽（proxy 依路徑與查詢字串改寫到此，實際網址不變）
export const dynamic = "force-dynamic";

export const metadata: Metadata = siteMetadata;
export const viewport: Viewport = siteViewport;

export default async function DynLayout({ children }: { children: React.ReactNode }) {
  return (
    <SiteShell sc={await getCtx()} mode="dynamic">
      {children}
    </SiteShell>
  );
}
