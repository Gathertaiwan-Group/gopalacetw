import type { Metadata } from "next";
import "./admin.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "後台 | 台灣宮廷藝術瓶", template: "%s | 後台 | 台灣宮廷藝術瓶" },
  robots: { index: false, follow: false },
};

export default function AdminRoot({ children }: { children: React.ReactNode }) {
  return <div className="adm-body">{children}</div>;
}
