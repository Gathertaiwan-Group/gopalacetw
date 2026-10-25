import type { Metadata } from "next";
import { SitePage, siteMetadataFor } from "@/app/_site/page-body";
import { ctxFor, pathFromSlug } from "@/lib/route";

export const revalidate = 300;
export const dynamicParams = true;

// 不預先產生：第一次請求時輸出並快取（ISR）
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return siteMetadataFor(await ctxFor(pathFromSlug(slug), ""));
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  return <SitePage sc={await ctxFor(pathFromSlug(slug), "")} mode="static" />;
}
