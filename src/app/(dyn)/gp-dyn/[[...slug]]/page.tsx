import type { Metadata } from "next";
import { SitePage, siteMetadataFor } from "@/app/_site/page-body";
import { getCtx } from "@/lib/route";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return siteMetadataFor(await getCtx());
}

export default async function Page() {
  return <SitePage sc={await getCtx()} mode="dynamic" />;
}
