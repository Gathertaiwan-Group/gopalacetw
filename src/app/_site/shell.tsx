import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "../globals.css";
import headAssets from "@/theme/head-assets.json";
import type { SiteCtx } from "@/lib/route";
import { currentCart, emptyCart } from "@/lib/cart";
import { renderChrome } from "@/theme/chrome";
import { archiveMain } from "@/theme/render";
import { Raw } from "@/components/Raw";
import { responsiveHtml } from "@/lib/images";
import { SITE_URL } from "@/lib/env";

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  other: { "msapplication-TileImage": "" },
};

export const siteViewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

const GTAG_ID = "GT-PLWXKL7F"; // Google Site Kit（features.json tracking.google_tag）
const FB_PIXEL = "536307372507413"; // PixelYourSite（features.json tracking.facebook_pixel）

/**
 * 前台版面（舊站 Blocksy 外框）。
 * mode="static"：ISR 公開頁，不讀 cookies，頁首購物車以空車輸出（前台 JS 依標記 cookie 補回）。
 * mode="dynamic"：購物車／結帳／會員／搜尋等，每次請求即時輸出。
 */
export async function SiteShell({ sc, mode, children }: { sc: SiteCtx; mode: "static" | "dynamic"; children: React.ReactNode }) {
  const { site, ctx, req } = sc;
  const tracking = site.settings.tracking || {};
  const gtagId = String((Array.isArray(tracking.google_tag) ? tracking.google_tag[0] : tracking.google_tag) || GTAG_ID).replace(/[^\w-]/g, "");
  const fbPixel = String((Array.isArray(tracking.facebook_pixel?.pixel_ids) ? tracking.facebook_pixel.pixel_ids[0] : tracking.facebook_pixel?.pixel_ids) || FB_PIXEL).replace(/[^\w-]/g, "");
  const cart = mode === "dynamic" ? await currentCart(site) : emptyCart(site);
  const widgets =
    ctx.kind === "shop" || ctx.kind === "product_cat" || ctx.kind === "product_tag"
      ? (() => {
          const a = archiveMain(site, ctx, req.search.toString() ? `?${req.search.toString()}` : "");
          return a.hasFilters ? a.widgets : undefined;
        })()
      : undefined;
  const c0 = renderChrome(site, ctx, cart, widgets);
  const R = (h: string) => responsiveHtml(site, h);
  const c = {
    ...c0,
    start: R(c0.start),
    header: R(c0.header),
    footer: R(c0.footer),
    end: c0.end === null ? null : R(c0.end),
    extra: R(c0.extra),
    css: R(c0.css),
    hooksBefore: c0.hooksBefore.map((h) => ({ ...h, html: R(h.html) })),
    hooksAfter: c0.hooksAfter.map((h) => ({ ...h, html: R(h.html) })),
  };
  const { className, ...bodyData } = c.body;
  const groups = headAssets.groups as Record<string, string[]>;
  const group =
    ctx.kind === "page"
      ? ctx.special || (ctx.post.content.includes("data-elementor-type") ? "page_elementor" : ctx.post.content.includes("data-products=") ? "page_products" : "page")
      : ctx.kind === "post_tag"
        ? "category"
        : ctx.kind === "notfound"
          ? "search"
          : ctx.kind;
  const styles = groups[group] || groups.page;

  return (
    <html lang="zh-TW" dir="ltr" data-theme="light" suppressHydrationWarning>
      <head>
        <link rel="profile" href="https://gmpg.org/xfn/11" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {styles.map((href) => (
          <link key={href} rel="stylesheet" href={href} media="all" />
        ))}
        <link rel="alternate" type="application/rss+xml" title="訂閱《台灣宮廷藝術瓶》&raquo; 資訊提供" href={`${SITE_URL}/feed/`} />
        <link rel="icon" href="/site-icon/32.png" sizes="32x32" />
        <link rel="icon" href="/site-icon/192.png" sizes="192x192" />
        <link rel="apple-touch-icon" href="/site-icon/180.png" />
        <Raw as="noscript" html={`<link rel="stylesheet" href="/wp-content/themes/blocksy/static/bundle/no-scripts.min.css" type="text/css">`} />
        <Raw as="style" id="gp-dynamic-css" html={c.css.replace(/<\/?style[^>]*>/g, "\n")} />
        <Script id="google_gtagjs-js" src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gtagId)}`} strategy="afterInteractive" />
        <Script id="google_gtagjs-js-after" strategy="afterInteractive">{`window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}
gtag("set","linker",{"domains":["go.palacetwshop.com"]});
gtag("js", new Date());
gtag("set", "developer_id.dZTNiMT", true);
gtag("config", ${JSON.stringify(gtagId)});`}</Script>
        <Script id="pys-fb-pixel" strategy="afterInteractive">{`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${JSON.stringify(fbPixel)});fbq('track','PageView');`}</Script>
      </head>
      <body className={className} {...bodyData} itemScope itemType="https://schema.org/WebPage" suppressHydrationWarning>
        <a className="skip-link show-on-focus" href="#main">
          跳至主要內容
        </a>
        <Raw className="ct-drawer-canvas" data-location="start" html={c.start} />
        <div id="main-container">
          <Raw as="header" id="header" className="ct-header" data-id="type-1" itemscope itemtype="https://schema.org/WPHeader" html={c.header} />
          {c.hooksBefore.map((h) => (
            <Raw key={h.attrs["data-block"]} {...h.attrs} html={h.html} />
          ))}
          {children}
          {c.hooksAfter.map((h) => (
            <Raw key={h.attrs["data-block"]} {...h.attrs} html={h.html} />
          ))}
          <Raw as="footer" id="footer" className="ct-footer" data-id="type-1" itemscope itemtype="https://schema.org/WPFooter" html={c.footer} />
        </div>
        {c.end !== null ? <Raw className="ct-drawer-canvas" data-location="end" data-shortcuts-bar="" html={c.end} /> : null}
        <Raw as="div" id="gp-body-end" style={{ display: "contents" }} html={c.extra} />
        <Raw as="noscript" html={`<img height="1" width="1" style="display: none;" src="https://www.facebook.com/tr?id=${fbPixel}&ev=PageView&noscript=1" alt="">`} />
        <Script src="/gp-theme.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
