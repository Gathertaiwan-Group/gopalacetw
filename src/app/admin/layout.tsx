import type { Metadata } from "next";
import "../globals.css";
import "./admin.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "後台 | 台灣宮廷藝術瓶", template: "%s | 後台 | 台灣宮廷藝術瓶" },
  robots: { index: false, follow: false },
};

export default function AdminRoot({ children }: { children: React.ReactNode }) {
  // 後台是獨立的根版面（前台在 (site)／(dyn) 路由群組，各自有 <html>）
  return (
    <html lang="zh-TW" suppressHydrationWarning>
      <body>
        <div className="adm-body">{children}</div>
      </body>
    </html>
  );
}
