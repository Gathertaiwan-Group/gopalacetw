import { F } from "./fragments.generated";
import { esc, priceHtml, stripTags, wpText } from "./util";
import { productUrl } from "./render";
import { mediaUrl, type Site } from "@/lib/data";
import type { Cart, CartLine } from "@/lib/cart";
import { lastDeals } from "@/lib/discounts";

const P = (n: number) => priceHtml(n, false);

function thumb(l: CartLine, ratio = "1/1", cls = "attachment-woocommerce_thumbnail size-woocommerce_thumbnail wp-post-image") {
  const m = l.product.images[0];
  if (!m) return "";
  return `<img loading="lazy" decoding="async" width="300" height="300" src="${esc(mediaUrl(m))}" class="${cls}" alt="" itemprop="image" style="aspect-ratio: ${ratio};">`;
}

function qty(l: CartLine, min = 0) {
  return `<div class="quantity" data-type="type-2">
	<span class="ct-increase"></span><span class="ct-decrease"></span>	<label class="screen-reader-text" for="quantity_l${l.id}">${wpText(l.product.name)} 數量</label>
	<input type="number" id="quantity_l${l.id}" class="input-text qty text" name="cart[${l.id}][qty]" value="${l.quantity}" aria-label="商品數量" min="${min}" max="" step="1" placeholder="" inputmode="numeric" autocomplete="off" data-line="${l.id}">
	</div>`;
}

function shippingProgress(cls: string) {
  // 舊站 Blocksy 免運進度條設定門檻為 0，固定顯示恭喜訊息（見快照）
  return `<div class="${cls}"><div class="ct-message">Congratulations! You got free shipping 🎉</div><div class="ct-progress-bar"><span style="width: 100%"></span></div></div>`;
}

export function miniCartHtml(cart: Cart) {
  if (!cart.lines.length) return `
<p class="woocommerce-mini-cart__empty-message">購物車內沒有任何商品。</p>

`;
  const items = cart.lines
    .map(
      (l) => `						<li class="woocommerce-mini-cart-item mini_cart_item">
					<a href="/cart-2/?remove_item=${l.id}" class="remove remove_from_cart_button" aria-label="從購物車中移除「${esc(stripTags(l.product.name))}」" data-product_id="${l.product.id}" data-cart_item_key="${l.id}" data-product_sku="${esc(l.product.sku || "")}">${F.removeIcon}</a><a class="ct-media-container" href="${productUrl(l.product)}">${thumb(l, "4/3", " wp-post-image")}</a>
					<div class="product-data">
						<a href="${productUrl(l.product)}" class="product-title">
							${wpText(l.product.name)}${l.discount_rule_id ? "（加價購）" : ""}						</a>
												<div class="ct-product-actions">${qty(l)}<span class="ct-product-multiply-symbol">×</span>${P(l.unit_price)}</div>					</div>
				</li>
`,
    )
    .join("");
  return `
	<ul class="woocommerce-mini-cart cart_list product_list_widget ">
${items}					</ul>

	<p class="woocommerce-mini-cart__total total">
		<strong>小計:</strong> ${P(cart.subtotal)}	</p>

	${shippingProgress("ct-shipping-progress-mini-cart")}
	<p class="woocommerce-mini-cart__buttons buttons"><a href="/cart-2/" class="button wc-forward">查看購物車</a><a href="/checkout-2/" class="button checkout wc-forward">結帳</a></p>

`;
}

function couponRows(cart: Cart) {
  return cart.coupons
    .map((c) => `<tr class="cart-discount coupon-${esc(c.code.toLowerCase())}">
			<th>優惠券：${esc(c.code)}</th>
			<td data-title="優惠券：${esc(c.code)}">-${P(c.amount)} <a href="#" class="woocommerce-remove-coupon" data-coupon="${esc(c.code)}">[移除]</a></td>
		</tr>`)
    .join("");
}

function shippingRow(cart: Cart, withDestination: boolean) {
  const label = cart.shipping > 0 ? `${esc(cart.shippingLabel)}: ${P(cart.shipping)}` : `${esc(cart.shippingLabel)}: 免運費`;
  return `<tr class="woocommerce-shipping-totals shipping">
	<th>運送方式</th>
	<td colspan="2" data-title="運送方式">
					<ul id="shipping_method" class="woocommerce-shipping-methods">
									<li>
						<input type="hidden" name="shipping_method[0]" data-index="0" id="shipping_method_0_flat_rate1" value="flat_rate:1" class="shipping_method"><label for="shipping_method_0_flat_rate1">${label}</label>					</li>
							</ul>
${withDestination ? `							<p class="woocommerce-shipping-destination">
					運送選項會在結帳時更新。				</p>
<form class="woocommerce-shipping-calculator" action="/cart-2/" method="post">
	<a href="#" class="shipping-calculator-button" aria-expanded="false" aria-controls="shipping-calculator-form" role="button">計算運費</a>
	<section class="shipping-calculator-form" id="shipping-calculator-form" style="display:none;">
					<p class="form-row form-row-wide" id="calc_shipping_country_field">
				<label for="calc_shipping_country" class="screen-reader-text">國家/地區：</label>
				<select name="calc_shipping_country" id="calc_shipping_country" class="country_to_state country_select" rel="calc_shipping_state">
					<option value="TW" selected="selected">台灣</option>				</select>
			</p>
					<p class="form-row validate-required form-row-wide address-field" id="calc_shipping_state_field">
					<label for="calc_shipping_state" class="screen-reader-text">縣 / 市&nbsp;<abbr class="required" title="必要欄位">*</abbr></label>
					<input type="text" class="input-text" value="" placeholder="縣 / 市" name="calc_shipping_state" id="calc_shipping_state" data-placeholder="縣 / 市">
								</p>
					<p class="form-row validate-required form-row-wide address-field" id="calc_shipping_city_field">
				<label for="calc_shipping_city" class="screen-reader-text">鄉鎮市&nbsp;<abbr class="required" title="必要欄位">*</abbr></label>
				<input type="text" class="input-text" value="" placeholder="鄉鎮市" name="calc_shipping_city" id="calc_shipping_city" data-placeholder="鄉鎮市">
			</p>
					<p class="form-row validate-required form-row-wide address-field" id="calc_shipping_postcode_field">
				<label for="calc_shipping_postcode" class="screen-reader-text">郵遞區號&nbsp;<abbr class="required" title="必要欄位">*</abbr></label>
				<input type="text" class="input-text" value="" placeholder="郵遞區號" name="calc_shipping_postcode" id="calc_shipping_postcode" data-placeholder="郵遞區號">
			</p>
		<p><button type="submit" name="calc_shipping" value="1" class="button">更新</button></p>
			</section>
</form>
` : ""}			</td>
</tr>`;
}

export function cartPageInner(cart: Cart) {
  if (!cart.lines.length) {
    return `<div class="woocommerce"><div class="woocommerce-notices-wrapper"></div><div class="wc-empty-cart-message">
	<div class="cart-empty woocommerce-info">
		您的購物車裡還沒有任何商品。	</div>
</div>	<p class="return-to-shop">
		<a class="button wc-backward" href="/">
			回到商店		</a>
	</p>
</div>`;
  }
  const rows = cart.lines
    .map(
      (l) => `								<tr class="woocommerce-cart-form__cart-item cart_item">
						<td class="product-thumbnail">
							<a class="ct-media-container" href="${productUrl(l.product)}">${thumb(l)}</a>						</td>
						<td class="product-name" data-title="商品">
							<a href="${productUrl(l.product)}">${wpText(l.product.name)}</a>${l.discount_rule_id ? `<dl class="variation"><dt>優惠:</dt><dd>加價購</dd></dl>` : ""}							<p class="price ct-hidden-sm ct-hidden-md">
								${P(l.unit_price)}							</p>
							<div class="product-mobile-actions ct-hidden-lg product-remove">
								${qty(l)}
								<span class="ct-product-multiply-symbol">×</span>
								${P(l.unit_price)}
								<a href="/cart-2/?remove_item=${l.id}" class="remove" aria-label="從購物車中移除「${esc(stripTags(l.product.name))}」" data-product_id="${l.product.id}" data-cart_item_key="${l.id}">
												${F.removeIcon}
											</a>							</div>
						</td>
						<td class="product-quantity" data-title="數量">
							${qty(l)}
						</td>
						<td class="product-subtotal" data-title="小計">
							${P(l.line_total)}						</td>
						<td class="product-remove" data-title="移除商品">
							<a href="/cart-2/?remove_item=${l.id}" class="remove" aria-label="從購物車中移除「${esc(stripTags(l.product.name))}」" data-product_id="${l.product.id}" data-cart_item_key="${l.id}">
											${F.removeIcon}
										</a>						</td>
					</tr>
`,
    )
    .join("");
  return `<div class="woocommerce"><div class="woocommerce-notices-wrapper"></div>
<div class="ct-woocommerce-cart-form">
<form class="woocommerce-cart-form" action="/cart-2/" method="post">
	<div class="ywdpd-cart-notices-wrapper">
</div>
	<table class="shop_table cart woocommerce-cart-form__contents" cellspacing="0">
		<thead>
			<tr>
				<th class="product-name" colspan="2">商品</th>
				<th class="product-quantity">數量</th>
				<th class="product-subtotal">小計</th>
				<th class="product-remove">&nbsp;</th>
			</tr>
		</thead>
		<tbody>
${rows}			<tr>
				<td colspan="6" class="actions">
											<div class="coupon">
							<label for="coupon_code" class="screen-reader-text">優惠券:</label> <input type="text" name="coupon_code" class="input-text" id="coupon_code" value="" placeholder="優惠券代碼"> <button type="submit" class="button" name="apply_coupon" value="使用優惠券">使用優惠券</button>
													</div>
					<button type="submit" class="button" name="update_cart" value="更新購物車" disabled="">更新購物車</button>
									</td>
			</tr>
					</tbody>
	</table>
	</form>
<div class="cart_totals ">
	<h2>購物車總計</h2>
	<table cellspacing="0" class="shop_table shop_table_responsive">
		<tbody><tr class="cart-subtotal">
			<th>小計</th>
			<td data-title="小計">${P(cart.subtotal)}</td>
		</tr>
			${couponRows(cart)}${shippingRow(cart, true)}
		<tr class="order-total">
			<th>總計</th>
			<td data-title="總計"><strong>${P(cart.total)}</strong> </td>
		</tr>
	</tbody></table>
	<div class="wc-proceed-to-checkout">
		${shippingProgress("ct-shipping-progress-cart-page")}
<a href="/checkout-2/" class="checkout-button button alt wc-forward">
	前往結帳</a>
	</div>
</div>
</div>
</div>`;
}

const COUNTIES = ["基隆市", "臺北市", "新北市", "宜蘭縣", "新竹市", "新竹縣", "桃園市", "苗栗縣", "臺中市", "彰化縣", "南投縣", "嘉義市", "嘉義縣", "雲林縣", "臺南市", "高雄市", "屏東縣", "臺東縣", "花蓮縣"];

function field(prefix: "billing" | "shipping", key: string, label: string, opts: { required?: boolean; cls?: string; type?: string; auto?: string; placeholder?: string; srLabel?: boolean; prio: number; value?: string }) {
  const name = `${prefix}_${key}`;
  const req = opts.required !== false;
  const lbl = opts.srLabel
    ? `<label for="${name}" class="screen-reader-text">${label}&nbsp;<span class="optional">(選填)</span></label>`
    : `<label for="${name}" class="">${label}${req ? '&nbsp;<abbr class="required" title="必要欄位">*</abbr>' : ""}</label>`;
  return `<p class="form-row ${opts.cls || "form-row-wide"}${req ? " validate-required" : ""}" id="${name}_field" data-priority="${opts.prio}">${lbl}<span class="woocommerce-input-wrapper"><input type="${opts.type || "text"}" class="input-text " name="${name}" id="${name}" placeholder="${esc(opts.placeholder || "")}" value="${esc(opts.value || "")}"${req ? ' aria-required="true"' : ""}${opts.auto ? ` autocomplete="${opts.auto}"` : ""}></span></p>`;
}

function twAddress(prefix: "billing" | "shipping", v: Record<string, string>) {
  return `<p class="form-row address-field validate-required form-row-wide" id="${prefix}_city_field" data-priority="70"><label for="${prefix}_city" class="">鄉鎮市&nbsp;<abbr class="required" title="必要欄位">*</abbr></label><span class="woocommerce-input-wrapper"><input type="text" class="input-text " name="${prefix}_city" id="${prefix}_city" placeholder="" value="${esc(v.city || "")}" aria-required="true" autocomplete="address-level2"></span></p><p class="form-row address-field validate-required validate-state form-row-wide" id="${prefix}_state_field" data-priority="80"><label for="${prefix}_state" class="">縣 / 市&nbsp;<abbr class="required" title="必要欄位">*</abbr></label><span class="woocommerce-input-wrapper"><input type="text" class="input-text " value="${esc(v.state || "")}" placeholder="" name="${prefix}_state" id="${prefix}_state" aria-required="true" autocomplete="address-level1" style="display: none;"></span><select name="${prefix}_county" class="tw-county" data-target="${prefix}_state"><option value="">縣市</option>${COUNTIES.map((c) => `<option value="${c}"${v.state === c ? " selected" : ""}>${c}</option>`).join("")}</select></p><p class="form-row address-field validate-required validate-postcode form-row-wide" id="${prefix}_postcode_field" data-priority="90"><label for="${prefix}_postcode" class="">郵遞區號&nbsp;<abbr class="required" title="必要欄位">*</abbr></label><span class="woocommerce-input-wrapper"><input type="text" class="input-text " name="${prefix}_postcode" id="${prefix}_postcode" placeholder="郵遞區號" value="${esc(v.postcode || "")}" aria-required="true" autocomplete="postal-code"></span></p>`;
}

export function checkoutPageInner(site: Site, cart: Cart, prefill: Record<string, string> = {}, notice = "") {
  const b = (k: string) => prefill[`billing_${k}`] || "";
  const orderRows = cart.lines
    .map(
      (l) => `						<tr class="cart_item">
					<td class="product-name">
						${wpText(l.product.name)}${l.discount_rule_id ? "（加價購）" : ""}&nbsp;						 <strong class="product-quantity">×&nbsp;${l.quantity}</strong>											</td>
					<td class="product-total">
						${P(l.line_total)}					</td>
				</tr>
`,
    )
    .join("");
  const pay = (site.settings.payment?.methods || [{ id: "ry_ecpay_credit", title: "信用卡" }])[0];
  return `<div class="woocommerce"><div class="woocommerce-notices-wrapper">${notice}</div>
<form name="checkout" method="post" class="checkout woocommerce-checkout ct-woocommerce-checkout" action="/api/checkout/" enctype="multipart/form-data" aria-label="結帳" novalidate="novalidate">
		<div class="ct-customer-details">
		<div class="col2-set" id="customer_details">
			<div class="col-1">
				<div class="wc-order-attribution-inputs"></div><div class="woocommerce-billing-fields">
		<h3>帳單資訊</h3>
	<div class="woocommerce-billing-fields__field-wrapper">
		<input type="hidden" name="billing_country" id="billing_country" value="TW" autocomplete="country" class="country_to_state" readonly="">	${field("billing", "first_name", "名字", { cls: "form-row-first", auto: "given-name", prio: 10, value: b("first_name") })}${field("billing", "last_name", "姓氏", { cls: "form-row-last", auto: "family-name", prio: 20, value: b("last_name") })}${field("billing", "company", "公司名稱", { required: false, auto: "organization", prio: 30, value: b("company") })}${field("billing", "address_1", "街道地址", { cls: "address-field form-row-wide", auto: "address-line1", placeholder: "門牌號碼與街道名稱", prio: 50, value: b("address_1") })}${field("billing", "address_2", "公寓、套房、單位等", { required: false, cls: "address-field form-row-wide", auto: "address-line2", placeholder: "公寓、套房、單元等(選填)", srLabel: true, prio: 60, value: b("address_2") })}${twAddress("billing", { city: b("city"), state: b("state"), postcode: b("postcode") })}${field("billing", "phone", "聯絡電話", { type: "tel", auto: "tel", prio: 100, value: b("phone") })}${field("billing", "email", "電子郵件地址", { type: "email", auto: "email username", prio: 110, value: b("email") })}</div>
	</div>
			</div>
			<div class="col-2">
				<div class="woocommerce-shipping-fields">
		<h3 id="ship-to-different-address">
			<label class="woocommerce-form__label woocommerce-form__label-for-checkbox checkbox">
				<input id="ship-to-different-address-checkbox" class="woocommerce-form__input woocommerce-form__input-checkbox input-checkbox" type="checkbox" name="ship_to_different_address" value="1"> <span>運送到不同的地址?</span>
			</label>
		</h3>
		<div class="shipping_address" style="display: none;">
			<div class="woocommerce-shipping-fields__field-wrapper">
				<input type="hidden" name="shipping_country" id="shipping_country" value="TW" autocomplete="country" class="country_to_state" readonly="">			${field("shipping", "first_name", "名字", { cls: "form-row-first", auto: "given-name", prio: 10 })}${field("shipping", "last_name", "姓氏", { cls: "form-row-last", auto: "family-name", prio: 20 })}${field("shipping", "company", "公司名稱", { required: false, auto: "organization", prio: 30 })}${field("shipping", "address_1", "街道地址", { cls: "address-field form-row-wide", auto: "address-line1", placeholder: "門牌號碼與街道名稱", prio: 50 })}${field("shipping", "address_2", "公寓、套房、單位等", { required: false, cls: "address-field form-row-wide", auto: "address-line2", placeholder: "公寓、套房、單元等(選填)", srLabel: true, prio: 60 })}${twAddress("shipping", {})}${field("shipping", "phone", "行動電話", { type: "tel", prio: 100 })}</div>
		</div>
	</div>
<div class="woocommerce-additional-fields">
		<div class="woocommerce-additional-fields__field-wrapper">
							<p class="form-row notes" id="order_comments_field" data-priority=""><label for="order_comments" class="">訂單備註</label><span class="woocommerce-input-wrapper"><textarea name="order_comments" class="input-text " id="order_comments" placeholder="您的訂單的備註，例如: 運送時的特別註記。" rows="2" cols="5"></textarea></span></p>					</div>
	</div>
			</div>
		</div>
		</div>
	<div class="ct-order-review">
	<h3 id="order_review_heading">您的訂單</h3>
	<div id="order_review" class="woocommerce-checkout-review-order">
		<table class="shop_table woocommerce-checkout-review-order-table">
	<thead>
		<tr>
			<th class="product-name">商品</th>
			<th class="product-total">小計</th>
		</tr>
	</thead>
	<tbody>
${orderRows}					</tbody>
	<tfoot>
		<tr class="cart-subtotal">
			<th>小計</th>
			<td>${P(cart.subtotal)}</td>
		</tr>
			${couponRows(cart)}${shippingRow(cart, false)}
		<tr class="order-total">
			<th>總計</th>
			<td><strong>${P(cart.total)}</strong> </td>
		</tr>
	</tfoot>
</table>
${shippingProgress("ct-shipping-progress-checkout-page")}<div id="payment" class="woocommerce-checkout-payment">
			<ul class="wc_payment_methods payment_methods methods">
			<li class="wc_payment_method payment_method_${esc(pay.id)}">
	<input id="payment_method_${esc(pay.id)}" type="radio" class="input-radio" name="payment_method" value="${esc(pay.id)}" checked="checked" data-order_button_text="使用信用卡付款" style="display: none;">
	<label for="payment_method_${esc(pay.id)}">
		${esc(pay.title)} <img src="/wp-content/plugins/woomp/includes/ry-woocommerce-tools/icon/ecpay_logo.png" alt="綠界科技">	</label>
			<div class="payment_box payment_method_${esc(pay.id)}">
			<p>使用信用卡付款</p>
		</div>
	</li>
		</ul>
		<div class="form-row place-order">
			<div class="woocommerce-terms-and-conditions-wrapper">
		<div class="woocommerce-privacy-policy-text"><p>Your personal data will be used to process your order, support your experience throughout this website, and for other purposes described in our <a href="/?page_id=3" class="woocommerce-privacy-policy-link" target="_blank">隱私權政策</a>.</p>
</div>
			</div>
		<button type="submit" class="button alt" name="woocommerce_checkout_place_order" id="place_order" value="下單購買" data-value="下單購買">使用信用卡付款</button>
		</div>
</div>
	</div>
	</div>
</form>
</div>`;
}

/** YITH 加價購彈窗（結帳頁） */
export function lastDealPopup(site: Site, cart: Cart) {
  if (!cart.lines.length) return "";
  const deal = lastDeals(site).find((d) => !cart.lines.some((l) => l.discount_rule_id === d.ruleId));
  if (!deal) return "";
  const p = site.products.find((x) => x.id === deal.productId && x.status === "publish");
  if (!p || p.stock_status === "outofstock") return "";
  const m = p.images[0];
  const regular = Number(p.price || 0);
  return `<div class="ywdpd_popup checkout" data-rule="${deal.ruleId}" style="display: none;">
    <div class="ywdpd_popup_wrapper " data-rule_id="${deal.ruleId}" data-mode="unit_product">
        <div class="ywdpd_popup_general_content">
            <span class="ywdpd_close"></span>
            <div class="ywdpd_popup_content">
                <div class="ywdpd_step1">
                    <div class="ywdpd_single_rule_container last_deals" data-allowed_items="-1" data-max_units="-1" data-countdown="">
                        <div class="ywdpd_rule_title">
							<p>${wpText(deal.title)}</p>                        </div>
                        <div class="ywdpd_popup_stage">
							<ul class="ywdpd_popup_items products owl-carousel owl-theme last_deals ywdpd_one_item owl-loaded">
	            <li class="product item" data-product_id="${p.id}" data-product_type="simple">
                <div class="ywdpd_single_product">
                    <div class="ywdpd_product_details">
					<span class="ywdpd_image_badge">
						<span class="ywdp_check_icon"></span>
					</span>
                        <div class="ywdpd_image_container">
							${m ? `<img width="300" height="300" src="${esc(mediaUrl(m))}" class="attachment-woocommerce_thumbnail size-woocommerce_thumbnail wp-post-image" alt="">` : ""}                        </div>
                    </div>
                    <h5>${wpText(p.name)}</h5>
                    <span class="price"><span class="sale-price"><del aria-hidden="true">${priceHtml(regular, false).replace(/<\/?bdi>/g, "")}</del> <span class="screen-reader-text">原始價格：NT$${regular.toLocaleString("en-US")}。</span><ins aria-hidden="true">${priceHtml(deal.price, false).replace(/<\/?bdi>/g, "")}</ins><span class="screen-reader-text">目前價格：NT$${deal.price.toLocaleString("en-US")}。</span></span></span>
                    <div class="ywdpd_qty_fields_container" data-min="1" data-max="${p.stock_quantity ?? 9999}">
                    <span class="single_add_to_cart_button button wp-element-button simple ywdpd-add-deal" data-rule="${deal.ruleId}" data-product="${p.id}">
						加入購物車				</span>
                    </div>
                </div>
            </li>
			</ul>
                        </div>
                    </div>
                    <div class="ywdpd_btn_container">
                        <a class="button ywdpd_btn_confirm">Confirm and close window</a>
                    </div>
                </div>
                <div class="ywdpd_step2"></div>
                <div class="ywdpd_footer">
                    <a href="#" rel="nofollow" class="ywdpd_no_thanks">
						No, thanks                    </a>
                </div>
            </div>
        </div>
    </div>
</div>`;
}

export function orderReceivedInner(order: { id: number; order_number: string | null; date_created: string; total: number | string; billing_email: string | null; payment_method_title: string | null; status: string }, items: { name: string; quantity: number; total: number | string }[], shipping: number, subtotal: number) {
  const d = new Date(new Date(order.date_created).getTime() + 8 * 3600 * 1000);
  const date = `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
  return `<div class="woocommerce"><div class="woocommerce-order">
		<p class="woocommerce-notice woocommerce-notice--success woocommerce-thankyou-order-received">謝謝，我們已收到你的訂單。本站目前尚未開放線上付款，訂單狀態為「待付款」，我們將與你聯繫付款方式。</p>
		<ul class="woocommerce-order-overview woocommerce-thankyou-order-details order_details">
			<li class="woocommerce-order-overview__order order">訂單編號：<strong>${esc(order.order_number || order.id)}</strong></li>
			<li class="woocommerce-order-overview__date date">日期：<strong>${date}</strong></li>
			${order.billing_email ? `<li class="woocommerce-order-overview__email email">電子郵件：<strong>${esc(order.billing_email)}</strong></li>` : ""}
			<li class="woocommerce-order-overview__total total">總計：<strong>${P(Number(order.total))}</strong></li>
			<li class="woocommerce-order-overview__payment-method method">付款方式：<strong>${esc(order.payment_method_title || "")}</strong></li>
		</ul>
	<section class="woocommerce-order-details">
	<h2 class="woocommerce-order-details__title">訂單詳細資料</h2>
	<table class="woocommerce-table woocommerce-table--order-details shop_table order_details">
		<thead><tr><th class="woocommerce-table__product-name product-name">商品</th><th class="woocommerce-table__product-table product-total">總計</th></tr></thead>
		<tbody>${items.map((i) => `<tr class="woocommerce-table__line-item order_item"><td class="woocommerce-table__product-name product-name">${wpText(i.name)} <strong class="product-quantity">×&nbsp;${i.quantity}</strong></td><td class="woocommerce-table__product-total product-total">${P(Number(i.total))}</td></tr>`).join("")}</tbody>
		<tfoot><tr><th scope="row">小計:</th><td>${P(subtotal)}</td></tr><tr><th scope="row">運送方式:</th><td>${shipping ? P(shipping) : "免運費"}</td></tr><tr><th scope="row">付款方式:</th><td>${esc(order.payment_method_title || "")}</td></tr><tr><th scope="row">總計:</th><td>${P(Number(order.total))}</td></tr></tfoot>
	</table>
	</section>
</div></div>`;
}
