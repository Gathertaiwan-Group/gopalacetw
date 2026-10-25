import { F } from "./fragments.generated";
import { encPath, esc, fill, priceHtml, wpText } from "./util";
import { archiveMain, breadcrumbs, floatingBar, hookBlock, termUrl } from "./render";
import { miniCartHtml, lastDealPopup } from "./shop";
import { mapUrl, type Site } from "@/lib/data";
import type { Ctx } from "@/lib/route";
import type { Cart } from "@/lib/cart";

const COMMON = "wp-embed-responsive wp-theme-blocksy wp-child-theme-blocksy-child theme-blocksy";
const TAIL = "gspbody gspb-bodyfront elementor-default elementor-kit-1136";

export type Hook = { attrs: Record<string, string>; html: string; css: string };

export type Chrome = {
  body: Record<string, string>;
  start: string; // .ct-drawer-canvas[data-location=start] 內容
  header: string; // <header> 內容
  hooksBefore: Hook[];
  hooksAfter: Hook[];
  footer: string; // <footer> 內容
  end: string | null; // .ct-drawer-canvas[data-location=end] 內容
  extra: string; // body 結尾（Chaty、彈窗）
  css: string;
};

function bodyFor(ctx: Ctx): { cls: string; prefix: string } {
  const paged = (page: number) => (page > 1 ? ` paged-${page}` : "");
  switch (ctx.kind) {
    case "shop":
      return {
        cls: `home archive${ctx.page > 1 ? " paged" : ""} post-type-archive post-type-archive-product ${COMMON.replace("wp-embed-responsive", `wp-embed-responsive${paged(ctx.page)}${ctx.page > 1 ? ` page-paged-${ctx.page}` : ""}`)} woocommerce-shop woocommerce woocommerce-page woocommerce-js ${TAIL} ct-elementor-default-template`,
        prefix: "woo_categories",
      };
    case "product_cat":
    case "product_tag": {
      const t = ctx.term;
      const term = /%/.test(t.slug) ? `term-${t.id}` : `term-${t.slug} term-${t.id}`;
      return {
        cls: `archive${ctx.page > 1 ? " paged" : ""} tax-${ctx.kind} ${term} wp-embed-responsive${paged(ctx.page)} wp-theme-blocksy wp-child-theme-blocksy-child theme-blocksy woocommerce woocommerce-page woocommerce-js ${TAIL} woocommerce-archive ct-elementor-default-template`,
        prefix: "woo_categories",
      };
    }
    case "category":
      return { cls: `archive category category-${ctx.term.slug} category-${ctx.term.id} ${COMMON} woocommerce-js ${TAIL} ct-elementor-default-template`, prefix: "categories" };
    case "post_tag":
      return { cls: `archive tag tag-${ctx.term.slug} tag-${ctx.term.id} ${COMMON} woocommerce-js ${TAIL} ct-elementor-default-template`, prefix: "categories" };
    case "blog":
      return { cls: `blog ${COMMON} woocommerce-js ${TAIL} ct-elementor-default-template`, prefix: "blog" };
    case "search":
      return { cls: `search search-results ${COMMON} woocommerce-js ${TAIL} ct-elementor-default-template`, prefix: "search" };
    case "product":
      return {
        cls: `wp-singular product-template-default single single-product postid-${ctx.product.id} ${COMMON} woocommerce woocommerce-page woocommerce-js ${TAIL} ct-elementor-default-template`,
        prefix: "product",
      };
    case "ct_content_block":
      return {
        cls: `wp-singular ct_content_block-template-default single single-ct_content_block postid-${ctx.post.id} ${COMMON} woocommerce-js ${TAIL} ct-elementor-default-template`,
        prefix: "ct_content_block_single:preview-mode",
      };
    case "page": {
      const woo = ctx.special === "cart" ? " woocommerce-cart woocommerce-page" : ctx.special === "checkout" ? " woocommerce-checkout woocommerce-page" : ctx.special === "account" ? " woocommerce-account woocommerce-page" : "";
      const el = ctx.post.content.includes("data-elementor-type") ? ` elementor-page elementor-page-${ctx.post.id}` : "";
      return { cls: `wp-singular page-template-default page page-id-${ctx.post.id} ${COMMON}${woo} woocommerce-js ${TAIL}${el} ct-elementor-default-template`, prefix: "single_page" };
    }
    default:
      return { cls: `error404 ${COMMON} woocommerce-js ${TAIL} ct-elementor-default-template`, prefix: "" };
  }
}

function menuItems(site: Site, ctx: Ctx, mobile: boolean) {
  const menu = site.menus.find((m) => m.location === "header");
  if (!menu) return "";
  const currentTermIds = new Set<number>();
  if (ctx.kind === "product") ctx.product.terms.forEach((t) => currentTermIds.add(t.id));
  const current = ctx.kind === "product_cat" ? ctx.term.id : null;
  const lis = menu.items
    .filter((i) => !i.parent_id)
    .map((i) => {
      const cls = ["menu-item", `menu-item-type-${i.object_type === "custom" ? "custom" : "taxonomy"}`, `menu-item-object-${i.object_type || "custom"}`];
      if (current && i.object_id === current) cls.push("current-menu-item");
      if (i.object_id && currentTermIds.has(i.object_id)) cls.push("current-product-ancestor current-menu-parent current-product-parent");
      cls.push(...(i.css_classes || []), `menu-item-${i.id}`);
      const href = i.url.startsWith("/") ? encPath(i.url) : i.url;
      return `<li${mobile ? "" : ` id="menu-item-${i.id}"`} class="${cls.join(" ")}" role="none"><a href="${esc(href)}" class="ct-menu-link" role="menuitem"${i.target ? ` target="${esc(i.target)}"` : ""}${i.rel ? ` rel="${esc(i.rel)}"` : ""}${current && i.object_id === current ? ' aria-current="page"' : ""}>${wpText(i.title)}</a></li>`;
    })
    .join("\n");
  return mobile ? `<ul id="menu-main-menu-1" role="menubar">${lis}\n</ul>` : `<ul id="menu-main-menu" class="menu" role="menubar">${lis}\n</ul>`;
}

function inner(html: string) {
  // 去掉最外層標籤，交給 React 元素輸出（保留 #main-container > [data-block] 等直接子層選擇器）
  const s = html.indexOf(">");
  const e = html.lastIndexOf("</");
  return html.slice(s + 1, e);
}

export function renderChrome(site: Site, ctx: Ctx, cart: Cart, archiveWidgets?: string): Chrome {
  const b = bodyFor(ctx);
  const transparent = !(ctx.kind === "product" || ctx.kind === "search" || ctx.kind === "notfound");
  const cartTrigger = (count: number, amount: number, autoOpen: string) =>
    fill(F.cartTrigger, { COUNT: String(count), AMOUNT: priceHtml(amount), AUTO_OPEN: autoOpen });
  const header = fill(F.header, {
    MENU: menuItems(site, ctx, false),
    CART_ITEM: cartTrigger(cart.count, cart.subtotal, 'data-auto-open="archive"'),
    T_ATTR: transparent ? ' data-transparent=""' : "",
    T_ROW: transparent ? ' data-transparent-row="yes"' : "",
  });

  // 後台「網站設定 → Logo」可覆寫（settings.site_logo.url）
  const logo = String(site.settings.site_logo?.url || "") || mapUrl(site, "https://go.palacetwshop.com/wp-content/uploads/2024/12/截圖_2024-12-20_上午5.00.17-removebg-preview.png");
  const isShopLike = ctx.kind === "shop" || ctx.kind === "product_cat" || ctx.kind === "product_tag";
  let start = fill(F.offcanvas, { MOBILE_MENU: menuItems(site, ctx, true), LOGO: logo });
  if (ctx.kind === "product") start += floatingBar(site, ctx.product);
  if (isShopLike && archiveWidgets !== undefined) start += fill(F.filtersPanel, { WIDGETS: archiveWidgets });
  start += fill(F.cartPanel, { MINI_CART: miniCartHtml(cart) });
  start += "\n" + F.accountModal;

  const hooksBefore: Hook[] = [];
  const hooksAfter: Hook[] = [];
  if (ctx.kind === "shop") {
    const h = hookBlock(site, 512, { crumbs: breadcrumbs([{ name: "首頁", url: "/" }], "--theme-text-color:#ffffff80;"), structure: true });
    if (h) hooksBefore.push(h);
  } else if (ctx.kind === "product_cat") {
    const h = hookBlock(site, 616, {
      crumbs: breadcrumbs([{ name: "首頁", url: "/" }, { name: ctx.term.name, url: termUrl(ctx.term) }], "--theme-text-color:#ffffff80;"),
      title: ctx.term.name,
    });
    if (h) hooksBefore.push(h);
  }
  const noFooterHook = false;
  if (!noFooterHook) {
    const h = hookBlock(site, 2365);
    if (h) hooksAfter.push(h);
  }

  const payment = mapUrl(site, "https://startersites.io/blocksy/pottery/wp-content/uploads/2024/03/payment-icons.svg");
  const footer = fill(F.footer, { PAYMENT_ICONS: payment, COPYRIGHT: esc(site.settings.footer?.copyright || "承城顧問有限公司版權所有") });

  let end: string | null = null;
  const isCartCheckout = ctx.kind === "page" && (ctx.special === "cart" || ctx.special === "checkout");
  if (!isCartCheckout) end = isShopLike && archiveWidgets !== undefined ? F.shortcutsShop : F.shortcutsDefault;

  let extra = F.chaty;
  if (ctx.kind === "page" && ctx.special === "checkout" && !(ctx.sub && ctx.sub.length)) extra = lastDealPopup(site, cart) + extra;
  else if (ctx.kind === "page" && ctx.special === "cart") extra = lastDealPopup(site, cart, "cart") + extra;

  const css = [...hooksBefore, ...hooksAfter].map((h) => h.css).join("");
  // 透明頁首的 Blocksy 動態 CSS（舊站 ct-main-styles-inline-css）
  const mainStyles = ctx.kind === "shop"
    ? `[data-block*="512"] > [class*="ct-container"] > article[class*="post"] {--has-boxed:var(--false);--has-wide:var(--true);} [data-header*="type-1"] {--has-transparent-header:1;}`
    : transparent
      ? `[data-header*="type-1"] {--has-transparent-header:1;}`
      : "";
  return {
    body: {
      className: b.cls,
      "data-link": "type-2",
      "data-prefix": b.prefix,
      "data-header": "type-1:sticky",
      "data-footer": "type-1",
      "data-ajax-filters": "yes",
    },
    start,
    header: inner(header),
    hooksBefore,
    hooksAfter,
    footer: inner(footer),
    end: end ? inner(end) : null,
    extra,
    css: (mainStyles ? `<style id="ct-main-styles-inline-css">${mainStyles}</style>` : "") + css,
  };
}

export { archiveMain };
