import { F } from "./fragments.generated";
import { encPath, esc, fill, money, priceHtml, stripTags, wpText } from "./util";
import { mapUrl, mediaUrl, sortProducts, visibleInCatalog, type Media, type Post, type Product, type Site, type Term } from "@/lib/data";
import type { Ctx, Filters } from "@/lib/route";
import { PER_PAGE } from "@/lib/route";

/* ---------------- 網址 ---------------- */
export function productUrl(p: Pick<Product, "slug">) {
  return `/product/${encPath(p.slug)}/`;
}
export function termUrl(t: Pick<Term, "taxonomy" | "slug">) {
  const base: Record<string, string> = { product_cat: "product-category", product_tag: "product-tag", category: "category", post_tag: "tag" };
  return `/${base[t.taxonomy] || t.taxonomy}/${encPath(t.slug)}/`;
}
function termClassSlug(t: Term) {
  return /%/.test(t.slug) ? String(t.id) : t.slug;
}

/* ---------------- 商品 ---------------- */
export function isPurchasable(p: Product) {
  return p.status === "publish" && p.price !== null && p.price !== "";
}
export function inStock(p: Product) {
  return p.stock_status === "instock" || p.stock_status === "onbackorder";
}
export function productPriceHtml(p: Product, encoded = true): string {
  if (p.price === null || p.price === "") return "";
  if (p.on_sale && p.regular_price && p.sale_price !== null && Number(p.sale_price) < Number(p.regular_price)) {
    return `<del aria-hidden="true">${priceHtml(p.regular_price, encoded)}</del> <span class="screen-reader-text">原始價格：NT$${money(p.regular_price)}。</span><ins aria-hidden="true">${priceHtml(p.sale_price, encoded)}</ins><span class="screen-reader-text">目前價格：NT$${money(p.sale_price)}。</span>`;
  }
  return priceHtml(p.price, encoded);
}
function productCats(p: Product) {
  return p.terms.filter((t) => t.taxonomy === "product_cat");
}
function productClasses(p: Product, i: number, extra = "") {
  const c = ["product", "type-product", `post-${p.id}`, `status-${p.status}`];
  if (i % 4 === 0) c.push("first");
  if (i % 4 === 3) c.push("last");
  c.push(inStock(p) ? "instock" : "outofstock");
  if (p.featured) c.push("featured");
  for (const t of productCats(p)) c.push(`product_cat-${termClassSlug(t)}`);
  for (const t of p.terms.filter((t) => t.taxonomy === "product_tag")) c.push(`product_tag-${termClassSlug(t)}`);
  if (p.images.length) c.push("has-post-thumbnail");
  if (p.on_sale) c.push("sale");
  c.push("shipping-taxable");
  if (isPurchasable(p)) c.push("purchasable");
  c.push(`product-type-${p.type}`);
  if (extra) c.push(extra);
  return c.join(" ");
}
function img(m: Media | undefined, opts: { cls?: string; ratio?: string; lazy?: boolean; title?: string } = {}) {
  if (!m) return "";
  const w = m.width || 600;
  const h = m.height || 600;
  return `<img${opts.lazy === false ? "" : ' loading="lazy"'} width="${w}" height="${h}" src="${esc(mediaUrl(m))}" alt="${esc(m.alt_text || "")}" decoding="async" itemprop="image" class="${opts.cls ?? " wp-post-image"}"${opts.ratio ? ` style="aspect-ratio: ${opts.ratio};"` : ""} title="${esc(opts.title ?? m.title ?? "")}" />`;
}
function catLinks(p: Product) {
  return productCats(p)
    .map((t) => `<a href="${termUrl(t)}" rel="tag" class="ct-term-${t.id}">${wpText(t.name)}</a>`)
    .join(", ");
}

export function productCard(p: Product, i: number, extra = "") {
  const url = productUrl(p);
  const badge = inStock(p) ? (p.on_sale ? `<span class="onsale" data-shape="type-2">特價</span>` : "") : `<span class="out-of-stock-badge" data-shape="type-2">售罄</span>`;
  const price = productPriceHtml(p);
  return `<li class="${productClasses(p, i, extra)}">
	<figure >${badge}<a class="ct-media-container has-hover-effect" href="${url}" aria-label="${esc(stripTags(p.name))}">${img(p.images[0], { ratio: "1/1" })}</a></figure><ul class="entry-meta" data-type="simple:none" data-id="ijRP1imnA1tIo4r_SDPLt" ><li class="meta-categories" data-type="simple">${catLinks(p)}</li></ul><h2 class="woocommerce-loop-product__title"><a class="woocommerce-LoopProduct-link woocommerce-loop-product__link" href="${url}" target="_self">${wpText(p.name)}</a></h2>
	${price ? `<span class="price">${price}</span>` : ""}
		</li>
`;
}

export function productsGrid(list: Product[], cls = "products  columns-4", extra = "") {
  return `<ul data-products="type-1" data-hover="zoom-in" class="${cls}">
${list.map((p, i) => productCard(p, i, extra)).join("")}</ul>`;
}

/* ---------------- 麵包屑 ---------------- */
export function breadcrumbs(items: { name: string; url: string }[], style = "") {
  const parts = items.map((it, i) => {
    const last = i === items.length - 1;
    const cls = i === 0 ? (last ? "last-item" : "first-item") : last ? "last-item" : `item-${i - 1}`;
    if (last)
      return `<span class="${cls}" aria-current="page" itemscope="" itemprop="itemListElement" itemtype="https://schema.org/ListItem"><meta itemprop="position" content="${i + 1}"><span itemprop="name">${wpText(it.name)}</span><meta itemprop="url" content="${esc(it.url)}"/></span>`;
    return `<span class="${cls}"${i === 0 ? " " : ""}itemscope="" itemprop="itemListElement" itemtype="https://schema.org/ListItem"><meta itemprop="position" content="${i + 1}"><a href="${esc(it.url)}" itemprop="item"><span itemprop="name">${wpText(it.name)}</span></a><meta itemprop="url" content="${esc(it.url)}"/>${F.breadcrumbSep}</span>`;
  });
  return `<nav class="ct-breadcrumbs" data-source="default" ${style ? `style="${style}" ` : ""}itemscope="" itemtype="https://schema.org/BreadcrumbList">${parts.join("")}			</nav>`;
}

/* ---------------- 內容區塊（Blocksy Content Blocks） ---------------- */
export function blockCss(post: Post | undefined) {
  return post?.custom_css ? `<style id="greenshift-post-css-${post.id}-inline-css">${post.custom_css}</style>` : "";
}

/** 把 DB 內靜態渲染的「商品短代碼」換成即時資料（保留原順序） */
export function liveProductShortcodes(site: Site, html: string) {
  return html.replace(/<ul data-products="type-1"([^>]*)>([\s\S]*?)<\/ul>\s*(?=<\/div>)/g, (m, attrs: string, inner: string) => {
    const ids = [...inner.matchAll(/<li class="product type-product post-(\d+)/g)].map((x) => Number(x[1]));
    if (!ids.length) return m;
    const list = ids.map((id) => site.products.find((p) => p.id === id && p.status === "publish")).filter(Boolean) as Product[];
    const cls = /class="([^"]*)"/.exec(attrs)?.[1] || "products columns-4";
    return productsGrid(list, cls);
  });
}

export function cleanContent(site: Site, html: string) {
  let s = html || "";
  // Elementor 動畫元素：無 Elementor JS 時直接顯示
  s = s.replace(/\belementor-invisible\b/g, "");
  // 殘留的舊站網址（媒體對照表）
  s = s.replace(/https?:\/\/go\.palacetwshop\.com\/wp-content\/uploads\/[^"'\s)<>]+/g, (u) => mapUrl(site, u));
  s = s.replace(/https:\/\/startersites\.io\/blocksy\/pottery\/wp-content\/uploads\/[^"'\s)<>]+/g, (u) => mapUrl(site, u));
  s = s.replace(/https?:\/\/go\.palacetwshop\.com\//g, "/");
  return liveProductShortcodes(site, s);
}

function injectHeroBreadcrumbs(html: string, crumbs: string) {
  return html.replace(/(<div class="wp-block-greenshift-blocks-row-column[^"]*" id="gspb_col-id-gsbp-b70c80c">)/, `$1${crumbs}\n`);
}

export function hookBlock(site: Site, id: number, opts: { crumbs?: string; title?: string; structure?: boolean } = {}) {
  const post = site.posts.find((p) => p.id === id && p.status === "publish");
  if (!post) return "";
  let content = cleanContent(site, post.content);
  if (opts.crumbs) content = injectHeroBreadcrumbs(content, opts.crumbs);
  if (opts.title !== undefined)
    content = content.replace(/(<h2[^>]*class="ct-dynamic-data[^"]*"[^>]*>)[\s\S]*?(<\/h2>)/, `$1${wpText(opts.title)}$2`);
  const article = `<article id="post-${post.id}" class="post-${post.id}"><div class="entry-content">${content}</div></article>`;
  const inner = opts.structure ? `<div class="ct-container-full" data-content="normal">${article}</div>` : article;
  return { attrs: { "data-block": `hook:${post.id}`, ...(opts.structure ? { "data-block-structure": "custom" } : {}) }, html: inner, css: blockCss(post) };
}

/* ---------------- 篩選小工具 ---------------- */
function filterHref(base: string, params: URLSearchParams) {
  const q = params.toString();
  return base + (q ? `?${q}` : "");
}

export function filterWidgets(site: Site, contextProducts: Product[], base: string, filters: Filters, currentTermId?: number) {
  if (!contextProducts.length) return `<div class="ct-widget widget_block" id="block-21"><div class="wp-block-group is-layout-constrained wp-block-group-is-layout-constrained"></div></div>`;
  const maxPrice = Math.max(0, ...contextProducts.map((p) => Number(p.price || 0)));
  const min = filters.min ?? 0;
  const max = filters.max ?? maxPrice;
  const pct = (v: number) => (maxPrice ? Math.round((v / maxPrice) * 100) : 0);
  const cats = site.terms
    .filter((t) => t.taxonomy === "product_cat" && t.id !== currentTermId)
    .map((t) => ({ t, n: contextProducts.filter((p) => inStock(p) && p.terms.some((x) => x.id === t.id)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => (a.t.name < b.t.name ? -1 : a.t.name > b.t.name ? 1 : 0));
  const sym = "&#78;&#84;&#36;";
  const price = `<div class="ct-widget widget_block" id="block-17"><div class="ct-block-wrapper">
<h3 class="wp-block-heading widget-title" id="filter-by-price" style="font-size:clamp(14px, 0.875rem + ((1vw - 3.2px) * 0.234), 17px);">依價格找</h3>

<div class="ct-filter-widget-wrapper"><div class="ct-price-filter" data-base="${esc(base)}"><div class="ct-price-filter-slider"><div class="ct-price-filter-range-track" style="--start: ${pct(min)}%; --end: ${pct(max)}%;"></div><input type="range" value="${min}" min="0" max="${maxPrice}" step="1" name="min_price"></input><span class="ct-price-filter-range-handle-min" style="inset-inline-start: ${pct(min)}%"><span class="ct-tooltip">${sym}${min}</span></span><input type="range" value="${max}" min="0" max="${maxPrice}" step="1" name="max_price"></input><span class="ct-price-filter-range-handle-max" style="inset-inline-start: ${pct(max)}%"><span class="ct-tooltip">${sym}${max}</span></span></div><div class="ct-price-filter-inputs"><span>Price:&nbsp;</span><span class="ct-price-filter-min">${sym}${min}</span><span>&nbsp;-&nbsp;</span><span class="ct-price-filter-max">${sym}${max}</span></div></div></div>
</div></div>`;
  const items = cats
    .map(({ t, n }) => {
      const sel = filters.cats.includes(t.id);
      const next = sel ? filters.cats.filter((x) => x !== t.id) : [...filters.cats, t.id];
      const ps = new URLSearchParams();
      if (next.length) ps.set("filter_product_cat", next.join(","));
      if (filters.min !== undefined) ps.set("min_price", String(filters.min));
      if (filters.max !== undefined) ps.set("max_price", String(filters.max));
      return `<li class="ct-filter-item${sel ? " active" : ""}"><div class="ct-filter-item-inner"><a href="${esc(filterHref(base, ps))}" rel="nofollow" aria-label="${esc(t.name)}" data-key="product_cat" data-value="${t.id}"><input type="checkbox" class="ct-checkbox" tabindex="-1" name="product_cat_${t.id}" aria-label="${esc(t.name)}"${sel ? " checked" : ""}><span class="ct-filter-label">${wpText(t.name)}</span><span class="ct-filter-count">${n}</span></a></div></li>`;
    })
    .join("");
  const catW = cats.length
    ? `<div class="ct-widget widget_block" id="block-18"><div class="ct-block-wrapper">
<h3 class="wp-block-heading widget-title" id="filter" style="font-size:clamp(14px, 0.875rem + ((1vw - 3.2px) * 0.234), 17px);">依分類找</h3>

<div class="ct-filter-widget-wrapper"><div class="ct-filter-search"><input type="search" placeholder="Find by category"></input>${F.filterSearchIcons}</div><ul class="ct-filter-widget" data-display-type="list" data-filter-criteria="taxonomy:product_cat">${items}</ul></div>
</div></div>`
    : "";
  return `${price}${catW}<div class="ct-widget widget_block" id="block-21"><div class="wp-block-group is-layout-constrained wp-block-group-is-layout-constrained"></div></div>`;
}

export function sidebar(widgets: string) {
  return `<aside class="ct-hidden-sm ct-hidden-md" data-type="type-1" id="sidebar" itemtype="https://schema.org/WPSideBar" itemscope="itemscope"><div class="ct-sidebar" data-sticky="sidebar">${widgets}</div></aside>`;
}

/* ---------------- 分頁 ---------------- */
export function pagination(base: string, page: number, pages: number, query: string, mode = "infinite_scroll") {
  if (pages <= 1) return "";
  if (mode === "simple") {
    const href = (n: number) => (n === 1 ? base : `${base}page/${n}/`) + query;
    const nums = Array.from({ length: pages }, (_, i) => i + 1)
      .map((n) => (n === page ? `<span aria-current="page" class="page-numbers current">${n}</span>` : `<a class="page-numbers" href="${href(n)}">${n}</a>`))
      .join("\n");
    const prev = page > 1 ? `<a class="prev page-numbers" rel="prev" href="${href(page - 1)}">${F.nextArrow.replace("<svg", '<svg style="transform:rotate(180deg)"')}上一頁</a>` : "";
    const next = page < pages ? `<a class="next page-numbers" rel="next" href="${href(page + 1)}">下一頁 ${F.nextArrow}</a>` : "";
    return `
		<nav class="ct-pagination" data-pagination="simple"  >
			${prev}<div class="ct-hidden-sm">${nums}</div>${next}
		</nav>`;
  }
  const href = (n: number) => (n === 1 && mode !== "infinite_scroll" ? base : `${base}page/${n}/`) + query;
  const out: string[] = [];
  if (page > 1)
    out.push(`<a class="prev page-numbers" rel="prev" href="${href(page - 1)}">${F.nextArrow.replace("<svg", '<svg style="transform:rotate(180deg)"')} 上一頁</a>`);
  for (let n = 1; n <= pages; n++) {
    if (n === page) out.push(`<span aria-current="page" class="page-numbers current">${n}</span>`);
    else out.push(`<a class="page-numbers" href="${href(n)}">${n}</a>`);
  }
  let nav = out.join("\n");
  if (page < pages) nav += `<a class="next page-numbers" rel="next" href="${href(page + 1)}">下一頁 ${F.nextArrow}</a>`;
  return `
		<nav class="ct-pagination" data-pagination="${mode}"  >
			${nav}
			${page < pages ? F.loadMoreHelper : ""}
		</nav>`;
}

/* ---------------- 商品彙整（商店 / 分類 / 標籤 / 規則頁） ---------------- */
export function applyFilters(list: Product[], f: Filters) {
  return list.filter((p) => {
    if (f.cats.length && !p.terms.some((t) => f.cats.includes(t.id))) return false;
    const price = Number(p.price || 0);
    if (f.min !== undefined && price < f.min) return false;
    if (f.max !== undefined && price > f.max) return false;
    return true;
  });
}

export function archiveData(site: Site, ctx: Extract<Ctx, { kind: "shop" | "product_cat" | "product_tag" }>) {
  let base = "/";
  let context = site.products.filter(visibleInCatalog);
  let termId: number | undefined;
  if (ctx.kind === "product_cat" || ctx.kind === "product_tag") {
    termId = ctx.term.id;
    context = context.filter((p) => p.terms.some((t) => t.id === ctx.term.id));
    base = termUrl(ctx.term);
  } else if (ctx.kind === "shop" && ctx.rule) {
    base = `/ywdpd_discount/${encPath(ctx.rule.slug)}/`;
  }
  const filtered = sortProducts(applyFilters(context, ctx.filters), ctx.filters.orderby);
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const items = filtered.slice((ctx.page - 1) * PER_PAGE, ctx.page * PER_PAGE);
  return { base, context, filtered, pages, items, termId };
}

export function archiveMain(site: Site, ctx: Extract<Ctx, { kind: "shop" | "product_cat" | "product_tag" }>, query: string) {
  const d = archiveData(site, ctx);
  const widgets = filterWidgets(site, d.context, d.base, ctx.filters, d.termId);
  const listing = d.items.length
    ? `<div class="woocommerce-notices-wrapper"></div>${F.listingTop}<div class="ct-products-container">${F.filtersLoading}${productsGrid(d.items)}
${pagination(d.base, ctx.page, d.pages, query)}</div>`
    : `<div class="ct-products-container">${F.filtersLoading}<div class="woocommerce-no-products-found">
	<div class="woocommerce-info">
		找不到符合您選擇的商品	</div>
</div>
</div>`;
  return {
    widgets,
    hasFilters: d.context.length > 0,
    html: `
		<div class="ct-container" data-sidebar="left" data-vertical-spacing="top:bottom"><section><header class="woocommerce-products-header">
	</header>
${listing}</section>${sidebar(widgets)}</div>	`,
  };
}

/* ---------------- 單一商品 ---------------- */
function galleryHtml(p: Product) {
  const imgs = p.images;
  const badge = inStock(p) ? (p.on_sale ? `<span class="onsale" data-shape="type-2">特價</span>` : "") : `<span class="out-of-stock-badge" data-shape="type-2">售罄</span>`;
  const fig = (m: Media) =>
    `<figure class="ct-media-container" data-src="${esc(mediaUrl(m))}" data-width="${m.width || 690}" data-height="${m.height || 690}">${img(m, { cls: imgs.length > 1 ? "" : " wp-post-image", ratio: "1/1", title: stripTags(p.name) })}</figure>`;
  if (imgs.length <= 1) {
    return `<div class="woocommerce-product-gallery"><div class="ct-product-gallery-container">${badge}<a href="#" class="woocommerce-product-gallery__trigger">🔍</a>${imgs[0] ? fig(imgs[0]) : ""}</div></div>`;
  }
  return `<div class="woocommerce-product-gallery"><div class="ct-product-gallery-container">${badge}<a href="#" class="woocommerce-product-gallery__trigger">🔍</a>
	<div
		class="flexy-container"
		data-flexy="no">
		<div class="flexy">
			<div class="flexy-view" data-flexy-view="boxed">
				<div
					class="flexy-items">
					${imgs.map((m) => `<div class="flexy-item">${fig(m)}</div>`).join("")}				</div>
			</div>
							${F.flexyPrev}
				${F.flexyNext}
					</div>
		<div class="flexy-pills" data-type="thumbs"><ol data-flexy="no:paused">${imgs
      .map((m, i) => `<li${i === 0 ? ' class="active"' : ""}><span class="ct-media-container" aria-label="幻燈片 ${i + 1}">${img(m, { cls: "", ratio: "1/1" })}</span></li>`)
      .join("")}</ol>${F.flexyPrev}${F.flexyNext}</div>	</div>
	</div></div>`;
}

function stockHtml(p: Product) {
  if (!inStock(p)) return `<p class="stock out-of-stock">缺貨</p>`;
  if (p.manage_stock && p.stock_quantity !== null) return `<p class="stock in-stock">${p.stock_quantity} 件庫存</p>`;
  return "";
}

function quantityInput(p: Product, name = "quantity", value = 1, min = 1) {
  const max = p.sold_individually ? 1 : p.manage_stock && p.stock_quantity !== null && p.backorders === "no" ? p.stock_quantity : p.purchase_max ?? "";
  return `<div class="quantity" data-type="type-2">
	<span class="ct-increase"></span><span class="ct-decrease"></span>	<label class="screen-reader-text" for="quantity_${p.id}">${wpText(p.name)} 數量</label>
	<input
		type="number"
				id="quantity_${p.id}"
		class="input-text qty text"
		name="${name}"
		value="${value}"
		aria-label="商品數量"
				min="${min}"
		max="${max}"
					step="1"
			placeholder=""
			inputmode="numeric"
			autocomplete="off"
			/>
	</div>`;
}

/** 可變商品：屬性選單（目前 44 件皆為 simple；保留 WooCommerce 結構以支援日後新增） */
function variationsForm(site: Site, p: Product) {
  const attrs = site.attributes.filter((a) => a.product_id === p.id && a.used_for_variations).sort((a, b) => a.position - b.position);
  const vars = site.variations.filter((v) => v.product_id === p.id);
  const data = vars.map((v) => ({
    variation_id: v.id,
    attributes: v.attributes,
    price: v.price,
    price_html: v.price !== null ? priceHtml(v.price) : "",
    is_in_stock: v.stock_status !== "outofstock",
    max_qty: v.manage_stock ? v.stock_quantity : null,
    image: v.image_media_id ? mediaUrl(site.media.find((m) => m.id === v.image_media_id)) : null,
  }));
  const rows = attrs
    .map((a) => {
      const key = a.attribute_id ? site.terms.find((t) => a.options.includes(t.slug))?.taxonomy || a.name : a.name;
      const field = `attribute_${key}`;
      return `<tr><th class="label"><label for="${esc(field)}">${wpText(a.name)}</label></th><td class="value"><select id="${esc(field)}" name="${esc(field)}" data-attribute_name="${esc(field)}"><option value="">選擇一個選項</option>${a.options
        .map((o) => `<option value="${esc(o)}">${wpText(site.terms.find((t) => t.slug === o)?.name || o)}</option>`)
        .join("")}</select></td></tr>`;
    })
    .join("");
  return `<form class="variations_form cart" action="${productUrl(p)}" method="post" enctype='multipart/form-data' data-product_id="${p.id}" data-product_variations="${esc(JSON.stringify(data))}">
	<table class="variations" cellspacing="0" role="presentation"><tbody>${rows}</tbody></table>
	<div class="single_variation_wrap"><div class="woocommerce-variation single_variation"></div><div class="woocommerce-variation-add-to-cart variations_button">${quantityInput(p)}<button type="submit" class="single_add_to_cart_button button alt disabled">加入購物車</button><input type="hidden" name="add-to-cart" value="${p.id}" /><input type="hidden" name="product_id" value="${p.id}" /><input type="hidden" name="variation_id" class="variation_id" value="0" /></div></div>
</form>`;
}

function cartForm(site: Site, p: Product) {
  if (p.type === "variable") return variationsForm(site, p);
  return `<form class="cart" action="${productUrl(p)}" method="post" enctype='multipart/form-data'>

		${quantityInput(p)}

		<button type="submit" name="add-to-cart" value="${p.id}" class="single_add_to_cart_button button alt">加入購物車</button>

			</form>`;
}

export function floatingBar(site: Site, p: Product) {
  if (!inStock(p) || !isPurchasable(p)) return "";
  return `<div
	class="ct-floating-bar"
	>
	<div class="ct-container">
		<section class="ct-floating-bar-content">
			<div class="ct-media-container">${p.images[0] ? img(p.images[0], { cls: "", ratio: "1/1", lazy: false, title: stripTags(p.name) }) : ""}</div>			<div class="ct-floating-bar-item-title">
				<div class="product-title">${wpText(p.name)}</div>				<p class="price">${productPriceHtml(p)}</p>
			</div>
		</section>

		<section class="ct-floating-bar-actions">
			${stockHtml(p)}

	${cartForm(site, p)}


		</section>
	</div>
</div>`;
}

/** YITH 數量折扣表（規則細節待第三階段 DB 匯入；有 bulk 規則才顯示） */
export function discountTable(site: Site, p: Product) {
  const rules = site.rules.filter((r) => r.active !== false && r.discount_mode === "bulk" && Array.isArray(r.rules) && r.rules.length);
  const applies = rules.filter((r) => {
    const a = r.apply_to as { products?: number[]; categories?: number[]; all?: boolean };
    if (!a || a.all) return true;
    return (a.products || []).includes(p.id) || (a.categories || []).some((c) => p.terms.some((t) => t.id === c));
  });
  if (!applies.length) return `<div class="ywdpd-table-discounts-wrapper"></div>`;
  const r = applies[0];
  const rows = (r.rules as { min?: number; max?: number; type?: string; amount?: number }[])
    .map((q) => {
      const base = Number(p.price || 0);
      const val = q.type === "percentage" ? base * (1 - Number(q.amount || 0) / 100) : q.type === "fixed-price" ? Number(q.amount) : base - Number(q.amount || 0);
      return `<tr><td>${q.min ?? 1}${q.max ? ` - ${q.max}` : "+"}</td><td>${priceHtml(val)}</td></tr>`;
    })
    .join("");
  return `<div class="ywdpd-table-discounts-wrapper"><div class="ywdpd-table-discounts"><p class="ywdpd-table-discounts-label"><strong>${wpText(r.title)}</strong></p><table id="ywdpd-quantity-table"><tr><th>數量</th><th>單價</th></tr>${rows}</table></div></div>`;
}

export function singleProductMain(site: Site, p: Product) {
  const cats = productCats(p);
  const related = sortProducts(
    site.products.filter((x) => x.id !== p.id && visibleInCatalog(x) && x.terms.some((t) => t.taxonomy === "product_cat" && cats.some((c) => c.id === t.id))),
  );
  // WooCommerce 相關商品為隨機 4 件；以商品 ID 做穩定洗牌，避免每次重新整理都不同
  const seeded = related
    .map((x) => ({ x, k: ((x.id * 9301 + p.id * 49297) % 233280) / 233280 }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 4)
    .map((o) => o.x);
  const sku = p.sku ? `<span class="sku_wrapper">貨號: <span class="sku">${esc(p.sku)}</span></span>\n	` : "";
  const posted = cats.length ? `<span class="posted_in">分類: ${cats.map((t) => `<a href="${termUrl(t)}" rel="tag">${wpText(t.name)}</a>`).join(", ")}</span>` : "";
  const tags = p.terms.filter((t) => t.taxonomy === "product_tag");
  const tagged = tags.length ? `\n	<span class="tagged_as">標籤: ${tags.map((t) => `<a href="${termUrl(t)}" rel="tag">${wpText(t.name)}</a>`).join(", ")}</span>` : "";
  const desc = p.description?.trim();
  const tabs = desc
    ? `
	<div class="woocommerce-tabs wc-tabs-wrapper" data-type="type-1:center" >
		<ul class="tabs wc-tabs is-width-constrained" role="tablist">
							<li class="description_tab active" id="tab-title-description" role="tab" aria-controls="tab-description">
					<a href="#tab-description">
						描述					</a>
				</li>
					</ul>
		<article>
			<div class="woocommerce-Tabs-panel woocommerce-Tabs-panel--description panel entry-content is-layout-constrained wc-tab" id="tab-description" role="tabpanel" aria-labelledby="tab-title-description">
${cleanContent(site, p.description)}
			</div>
				</article>
			</div>`
    : "";
  return `
	<div class="ct-container-full" data-content="normal"  data-vertical-spacing="top:bottom"><article class="post-${p.id}">
			<div class="woocommerce-notices-wrapper"></div><div id="product-${p.id}" class="${productClasses(p, 0, "ct-default-gallery").replace(" first", " first")}">
	<div class="product-entry-wrapper is-width-constrained">${galleryHtml(p)}
	<div  class="summary entry-summary entry-summary-items">
		<h1 class="product_title entry-title">${wpText(p.name)}</h1>${p.short_description ? `<div class="woocommerce-product-details__short-description">
	${cleanContent(site, p.short_description)}
</div>
` : ""}${discountTable(site, p)}<div class="ywdpd-notices-wrapper"></div><span class="ct-product-divider" data-id="divider_1"></span><div class="product_meta">
		${sku}${posted}${tagged}
</div>
	</div>
	</div>${tabs}
</div>
${seeded.length ? `	<section class="related products is-width-constrained ct-hidden-sm ct-hidden-md">
					<h2 class="ct-module-title">相關商品</h2>
		${productsGrid(seeded, "products columns-4", "ct-default-gallery")}
	</section>` : ""}
	</article></div>
	`;
}

/* ---------------- 頁面 / 部落格 / 搜尋 / 404 ---------------- */
export function pageMain(site: Site, post: Post, inner?: string) {
  const bm = (post.meta?.blocksy_meta || {}) as Record<string, unknown>;
  if (inner === undefined && post.post_type === "ct_content_block" && (post.id === 512 || post.id === 616)) {
    inner = injectHeroBreadcrumbs(cleanContent(site, post.content), breadcrumbs([{ name: "首頁", url: "/" }, { name: post.title, url: post.path || "/" }], "--theme-text-color:#ffffff80;"));
  }
  const hero = bm.has_hero_section !== "disabled";
  const spacing = bm.content_area_spacing === "none" ? "" : `		data-vertical-spacing="top:bottom"`;
  return `${blockCss(post)}
	<div
		class="ct-container-full"
				data-content="normal"${spacing}>
	<article
		id="post-${post.id}"
		class="post-${post.id} ${post.post_type} type-${post.post_type} status-${post.status} hentry">
		${post.post_type === "page" && !inner ? `<div class="blocksy-woo-messages-default woocommerce-notices-wrapper"><div class="woocommerce"></div></div>\n` : ""}${hero && post.post_type === "page" ? `<div class="hero-section is-width-constrained" data-type="type-1">
			<header class="entry-header">
			<h1 class="page-title" title="${esc(stripTags(post.title))}" itemprop="headline">${wpText(post.title)}</h1>		</header>
	</div>
` : ""}		<div class="entry-content is-layout-constrained">
			${inner ?? cleanContent(site, post.content)}		</div>
	</article>
			</div>
	`;
}

export function searchForm() {
  return F.searchForm;
}

export function noResults() {
  return `<section class="ct-no-results">
		<div class="entry-content is-layout-flow">
${F.searchForm}
</div>	</section>`;
}

export function heroType2(site: Site, title: string, crumbs: { name: string; url: string }[]) {
  const heroImg = mapUrl(site, "https://go.palacetwshop.com/wp-content/uploads/2024/03/contact-page-hero-image.webp");
  return `<div class="hero-section" data-type="type-2">
			<figure>
			<div class="ct-media-container"><img loading="lazy" width="1700" height="550" src="${esc(heroImg)}" class="attachment-full size-full" alt="" decoding="async" itemprop="image" /></div>		</figure>
			<header class="entry-header ct-container">
			${breadcrumbs(crumbs)}
		<h2 class="page-title" title="${esc(title)}" itemprop="headline">${wpText(title)}</h2>		</header>
	</div>
`;
}

function entryDate(d: string | null) {
  if (!d) return "";
  const dt = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  return `<li class="meta-date" itemprop="datePublished"><time class="ct-meta-element-date" datetime="${dt.toISOString().replace(/\.\d+Z$/, "+08:00")}">${dt.getUTCDate()} ${dt.getUTCMonth() + 1} 月, ${dt.getUTCFullYear()}</time></li>`;
}

export type SearchHit = { type: "product"; p: Product } | { type: "page"; post: Post };

export function searchHits(site: Site, s: string, postType?: string | null): SearchHit[] {
  const q = s.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const match = (...texts: string[]) => {
    const hay = texts.map((t) => stripTags(t).toLowerCase()).join(" \n ");
    return words.every((w) => hay.includes(w));
  };
  const hits: { h: SearchHit; title: boolean; date: string; id: number }[] = [];
  if (!postType || postType === "product")
    for (const p of site.products.filter((x) => x.status === "publish" && (x.catalog_visibility === "visible" || x.catalog_visibility === "search")))
      if (match(p.name, p.short_description, p.description))
        hits.push({ h: { type: "product", p }, title: words.every((w) => stripTags(p.name).toLowerCase().includes(w)), date: p.published_at || "", id: p.id });
  if (!postType || postType === "page" || postType === "post")
    for (const post of site.posts.filter((x) => (x.post_type === "page" || x.post_type === "post") && x.status === "publish"))
      if (match(post.title, post.excerpt, post.content))
        hits.push({ h: { type: "page", post }, title: words.every((w) => stripTags(post.title).toLowerCase().includes(w)), date: post.published_at || "", id: post.id });
  // WordPress 預設：標題符合優先，其次依日期新到舊
  hits.sort((a, b) => Number(b.title) - Number(a.title) || new Date(b.date).getTime() - new Date(a.date).getTime() || a.id - b.id);
  return hits.map((x) => x.h);
}

export function searchCard(site: Site, h: SearchHit) {
  if (h.type === "product") {
    const p = h.p;
    const url = productUrl(p);
    const excerpt = stripTags(p.short_description || p.description).slice(0, 55);
    // Blocksy 摘要長度：舊站顯示短描述前 4 個詞（約前兩行）
    const short = p.short_description
      ? cleanContent(site, p.short_description).replace(/<\/?p>/g, "").split(/<br\s*\/?>/).slice(0, 2).join("<br />\n")
      : "";
    return `<article class="entry-card card-content post-${p.id} product type-product status-publish has-post-thumbnail"><ul class="entry-meta" data-type="simple:slash" data-id="meta_1" ><li class="meta-categories" data-type="simple">${catLinks(p)}</li></ul><h2 class="entry-title"><a href="${url}" rel="bookmark">${wpText(p.name)}</a></h2><a class="ct-media-container boundless-image" href="${url}" aria-label="${esc(stripTags(p.name))}">${img(p.images[0], { cls: "attachment-medium_large size-medium_large wp-post-image", ratio: "4/3" })}</a><div class="entry-excerpt"><p>${short || esc(excerpt)}</p>
</div><ul class="entry-meta" data-type="simple:slash" data-id="meta_2" >${entryDate(p.published_at)}</ul></article>`;
  }
  const post = h.post;
  const url = post.path || "/";
  const ex = stripTags(post.excerpt || "").slice(0, 60);
  return `<article class="entry-card card-content post-${post.id} page type-page status-publish hentry"><h2 class="entry-title"><a href="${encPath(url)}" rel="bookmark">${wpText(post.title)}</a></h2>${ex ? `<div class="entry-excerpt"><p>${esc(ex)}…</p>
</div>` : ""}<ul class="entry-meta" data-type="simple:slash" data-id="meta_2" >${entryDate(post.published_at)}</ul></article>`;
}

export function searchMain(site: Site, s: string, page: number, postType?: string | null) {
  const hits = searchHits(site, s, postType);
  const perPage = Number(site.settings.reading?.posts_per_page) || 6; // 舊站搜尋每頁 6 筆
  const pages = Math.max(1, Math.ceil(hits.length / perPage));
  const items = hits.slice((page - 1) * perPage, page * perPage);
  const title = `「${esc(s)}」的搜尋結果`;
  const query = `?s=${encodeURIComponent(s)}${postType ? `&post_type=${encodeURIComponent(postType)}` : ""}`;
  const body = items.length
    ? `<div class="entries" data-archive="default" data-layout="grid" data-cards="boxed">${items.map((h) => searchCard(site, h)).join("")}</div>${pagination("/", page, pages, query, "simple")}`
    : `<div class="entry-content is-layout-flow"><p>很抱歉，但沒有任何內容符合你的搜尋條件。請使用不同關鍵字再試一次。</p>${F.searchForm}</div>`;
  return { count: hits.length, html: `
<div class="ct-container"  data-vertical-spacing="top:bottom">
	<section >
<div class="hero-section is-width-constrained" data-type="type-1">
			<header class="entry-header">
			<h1 class="page-title" title="${title}" itemprop="headline">${title}</h1>		</header>
	</div>${items.length ? "" : ""}${body}	</section>
	</div>
	` };
}

export function notFoundMain() {
  return `
	<div class="ct-container" data-vertical-spacing="top:bottom">
		<section class="ct-no-results">
			<section class="hero-section" data-type="type-1">
				<header class="entry-header">
					<h1 class="page-title" itemprop="headline">很抱歉，找不到符合條件的頁面。</h1>
				</header>
			</section>
			<div class="page-content">
				<p>看起來在這個位置找不到東西. 也許可以試著找其他的?</p>
				${F.searchForm}
			</div>
		</section>
	</div>
	`;
}
