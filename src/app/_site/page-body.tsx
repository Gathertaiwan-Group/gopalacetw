import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { SiteCtx } from "@/lib/route";
import { seoFor } from "@/lib/seo";
import { currentCart } from "@/lib/cart";
import { currentUser, customerFor } from "@/lib/auth";
import { serviceDb } from "@/lib/supabase";
import { rawSearchIndex } from "@/lib/data";
import { Raw } from "@/components/Raw";
import {
  archiveMain,
  cleanContent,
  heroType2,
  noResults,
  pageMain,
  searchMain,
  singleProductMain,
  termUrl,
} from "@/theme/render";
import { cartPageInner, checkoutPageInner, orderReceivedInner } from "@/theme/shop";
import { accountInner, loginRegisterInner, lostPasswordInner, type OrderRow } from "@/theme/account";
import { esc, priceHtml, wpText } from "@/theme/util";

export function siteMetadataFor({ site, ctx, req }: SiteCtx): Metadata {
  return seoFor(site, ctx, req).meta;
}

const CW = { itemScope: true, itemType: "https://schema.org/CreativeWork" } as const;

/** 前台頁面主體。mode="static"（ISR）不得讀 cookies：購物車／結帳／會員／搜尋由 proxy 導向動態路由 */
export async function SitePage({ sc, mode }: { sc: SiteCtx; mode: "static" | "dynamic" }) {
  const { site, ctx, req } = sc;
  if (ctx.kind === "notfound") notFound();
  if (mode === "static" && (ctx.kind === "search" || (ctx.kind === "page" && ctx.special))) notFound();
  const seo = seoFor(site, ctx, req);
  const query = req.search.toString() ? `?${req.search.toString()}` : "";

  let main: React.ReactNode = null;
  switch (ctx.kind) {
    case "shop":
    case "product_cat":
    case "product_tag": {
      const a = archiveMain(site, ctx, query);
      main = <Raw site={site} as="main" id="main" className="site-main hfeed" {...CW} html={a.html} />;
      break;
    }
    case "product":
      main = <Raw site={site} as="main" id="main" className="site-main hfeed" {...CW} html={singleProductMain(site, ctx.product)} />;
      break;
    case "search": {
      const r = searchMain(site, ctx.s, ctx.page, ctx.postType, await rawSearchIndex(ctx.s));
      main = <Raw site={site} as="main" id="main" className="site-main hfeed" {...CW} html={r.html} />;
      break;
    }
    case "blog":
      main = (
        <Raw
          site={site}
          as="main"
          id="main"
          className="site-main hfeed"
          {...CW}
          html={`${heroType2(site, ctx.post.title, [{ name: "首頁", url: "/" }, { name: ctx.post.title, url: ctx.post.path || "/" }])}<div class="ct-container"  data-vertical-spacing="top:bottom">
	${noResults()}
	</div>
	`}
        />
      );
      break;
    case "category":
    case "post_tag": {
      const blog = site.posts.find((p) => p.id === site.settings.reading?.page_for_posts);
      const crumbs = [{ name: "首頁", url: "/" }, ...(blog ? [{ name: blog.title, url: blog.path || "/" }] : []), { name: ctx.term.name, url: termUrl(ctx.term) }];
      main = (
        <Raw
          site={site}
          as="main"
          id="main"
          className="site-main hfeed"
          {...CW}
          html={`${heroType2(site, ctx.term.name, crumbs)}<div class="ct-container"  data-vertical-spacing="top:bottom">
	${noResults()}
	</div>
	`}
        />
      );
      break;
    }
    case "ct_content_block":
      main = <Raw site={site} as="main" id="main" className="site-main hfeed" {...CW} html={`${pageMain(site, ctx.post).replace("<article", "<article")}`} />;
      break;
    case "page": {
      let inner: string | undefined;
      if (ctx.special === "cart") {
        const cart = await currentCart(site);
        inner = cartPageInner(cart);
      } else if (ctx.special === "checkout") {
        if (ctx.sub?.[0] === "order-received") {
          inner = await orderReceived(Number(ctx.sub[1]), req.search.get("key"));
        } else {
          const cart = await currentCart(site);
          if (!cart.lines.length) redirect("/cart-2/");
          const user = await currentUser();
          let prefill: Record<string, string> = {};
          if (user) {
            const c = await customerFor(user, { create: false });
            const bill = (c?.billing || {}) as Record<string, string>;
            prefill = Object.fromEntries(Object.entries(bill).map(([k, v]) => [`billing_${k}`, String(v ?? "")]));
            if (!prefill.billing_email && user.email) prefill.billing_email = user.email;
          }
          const err = req.search.get("error");
          inner = checkoutPageInner(site, cart, prefill, err ? `<ul class="woocommerce-error" role="alert"><li>${esc(err)}</li></ul>` : "");
        }
      } else if (ctx.special === "account") {
        inner = await accountPage(ctx.sub || [], req.search);
      }
      const html = pageMain(site, ctx.post, inner);
      main = <Raw site={site} as="main" id="main" className="site-main hfeed" html={html} />;
      break;
    }
  }

  const prev = "prev" in seo ? seo.prev : undefined;
  const next = "next" in seo ? seo.next : undefined;
  return (
    <>
      {Object.entries(seo.ogProperties || {}).map(([k, v]) => (
        <meta key={k} property={k} content={v} />
      ))}
      {prev ? <link rel="prev" href={prev} /> : null}
      {next ? <link rel="next" href={next} /> : null}
      {seo.jsonLd ? (
        <script type="application/ld+json" className="rank-math-schema" dangerouslySetInnerHTML={{ __html: JSON.stringify(seo.jsonLd).replace(/</g, "\\u003c") }} />
      ) : null}
      {main}
    </>
  );
}

async function orderReceived(id: number, key: string | null) {
  if (!id || !key) return `<div class="woocommerce"><ul class="woocommerce-error" role="alert"><li>找不到訂單。</li></ul></div>`;
  const db = serviceDb();
  const { data: order } = await db
    .from("orders")
    .select("id,order_number,order_key,date_created,total,subtotal,shipping_total,billing_email,payment_method_title,status")
    .eq("id", id)
    .eq("order_key", key)
    .maybeSingle();
  if (!order) return `<div class="woocommerce"><ul class="woocommerce-error" role="alert"><li>找不到訂單。</li></ul></div>`;
  const { data: items } = await db.from("order_items").select("name,quantity,total,item_type").eq("order_id", id).eq("item_type", "line_item").order("id");
  return orderReceivedInner(order, items || [], Number(order.shipping_total), Number(order.subtotal));
}

async function accountPage(sub: string[], sp: URLSearchParams) {
  const notice = sp.get("error")
    ? `<ul class="woocommerce-error" role="alert"><li>${esc(sp.get("error"))}</li></ul>`
    : sp.get("message")
      ? `<div class="woocommerce-message" role="alert">${esc(sp.get("message"))}</div>`
      : "";
  if (sub[0] === "lost-password") return lostPasswordInner(notice);
  const user = await currentUser();
  if (!user) return loginRegisterInner(notice, sp.get("action") === "register");
  const customer = await customerFor(user, { create: false });
  const db = serviceDb();
  const email = (user.email || "").toLowerCase();
  const like = `"${email.replace(/[\\%_"]/g, (m) => "\\" + m)}"`;
  // 以 billing email 比對訪客訂單：僅限 email 已驗證的帳號
  const verified = !!user.email_confirmed_at && !!email;
  const ors = [customer?.id ? `customer_id.eq.${customer.id}` : "", verified ? `billing_email.ilike.${like}` : ""].filter(Boolean).join(",") || "id.eq.0";
  const { data: orders } = await db
    .from("orders")
    .select("id,order_number,date_created,status,total,order_items(quantity,item_type)")
    .or(ors)
    .eq("type", "shop_order")
    .order("date_created", { ascending: false })
    .limit(100);
  const rows: OrderRow[] = (orders || []).map((o: any) => ({
    id: o.id,
    order_number: o.order_number,
    date_created: o.date_created,
    status: o.status,
    total: o.total,
    item_count: (o.order_items || []).filter((i: any) => i.item_type === "line_item").reduce((s: number, i: any) => s + i.quantity, 0),
  }));
  if (sub[0] === "orders") return accountInner(user.email || "", "orders", rows);
  if (sub[0] === "view-order") {
    const id = Number(sub[1]);
    const mine = rows.find((r) => r.id === id);
    if (!mine) return accountInner(user.email || "", "orders", rows);
    const { data: items } = await db.from("order_items").select("name,quantity,total,item_type").eq("order_id", id).order("id");
    const lines = (items || []).filter((i) => i.item_type === "line_item");
    const detail = `<p>訂單 #<mark class="order-number">${esc(mine.order_number || mine.id)}</mark> 於 <mark class="order-date">${esc(new Date(mine.date_created).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" }))}</mark> 建立，目前狀態為 <mark class="order-status">${esc(mine.status === "pending" ? "待付款" : mine.status)}</mark>。</p>
<section class="woocommerce-order-details"><h2 class="woocommerce-order-details__title">訂單詳細資料</h2><table class="woocommerce-table woocommerce-table--order-details shop_table order_details"><thead><tr><th class="product-name">商品</th><th class="product-total">總計</th></tr></thead><tbody>${lines
      .map((i) => `<tr class="order_item"><td class="product-name">${wpText(i.name)} <strong class="product-quantity">×&nbsp;${i.quantity}</strong></td><td class="product-total">${priceHtml(i.total, false)}</td></tr>`)
      .join("")}</tbody><tfoot><tr><th scope="row">總計:</th><td>${priceHtml(mine.total, false)}</td></tr></tfoot></table></section>`;
    return accountInner(user.email || "", "view-order", rows, detail);
  }
  return accountInner(user.email || "", "dashboard", rows);
}

// 供 ct_content_block 預覽頁使用（避免未使用警告）
void cleanContent;
