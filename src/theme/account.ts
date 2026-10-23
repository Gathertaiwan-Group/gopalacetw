import { esc, priceHtml } from "./util";
import { REGISTRATION_ENABLED } from "@/lib/env";

export function loginRegisterInner(notice = "", showRegister = false) {
  // 舊站只有登入表單（與舊站一致，預設不提供註冊）；ENABLE_CUSTOMER_REGISTRATION=1 時才在登入表單下方提供註冊（?action=register 展開）
  const reg = REGISTRATION_ENABLED;
  return `<div class="woocommerce ct-woo-unauthorized"><div class="woocommerce-notices-wrapper">${notice}</div>
		<h2>登入</h2>
		<form class="woocommerce-form woocommerce-form-login login" method="post" action="/api/account/login/" data-ajax="login">
			<p class="woocommerce-form-row woocommerce-form-row--wide form-row form-row-wide">
				<label for="username">使用者名稱 或 電子郵件&nbsp;<span class="required" aria-hidden="true">*</span><span class="screen-reader-text">必填</span></label>
				<input type="text" class="woocommerce-Input woocommerce-Input--text input-text" name="username" id="username" autocomplete="username" value="" required aria-required="true" />			</p>
			<p class="woocommerce-form-row woocommerce-form-row--wide form-row form-row-wide">
				<label for="password">密碼&nbsp;<span class="required" aria-hidden="true">*</span><span class="screen-reader-text">必填</span></label>
				<input class="woocommerce-Input woocommerce-Input--text input-text" type="password" name="password" id="password" autocomplete="current-password" required aria-required="true" />
			</p>
			<p class="form-row">
				<label class="woocommerce-form__label woocommerce-form__label-for-checkbox woocommerce-form-login__rememberme">
					<input class="woocommerce-form__input woocommerce-form__input-checkbox" name="rememberme" type="checkbox" id="rememberme" value="forever" /> <span>保持登入</span>
				</label>
				<input type="hidden" name="form" value="my-account-login" />				<button type="submit" class="woocommerce-button button woocommerce-form-login__submit" name="login" value="登入">登入</button>
			</p>
			<p class="woocommerce-LostPassword lost_password">
				<a href="/my-account-2/lost-password/">忘記密碼？</a>${reg ? `　<a href="/my-account-2/?action=register" class="gp-register-toggle">還沒有帳號？註冊</a>` : ""}
			</p>
		</form>
${reg ? `		<div id="customer_register"${showRegister ? "" : ' style="display:none"'}>
		<h2>註冊</h2>
		<form method="post" class="woocommerce-form woocommerce-form-register register" action="/api/account/register/" data-ajax="register">
			<p class="woocommerce-form-row woocommerce-form-row--wide form-row form-row-wide">
				<label for="reg_email">電子郵件地址&nbsp;<span class="required" aria-hidden="true">*</span><span class="screen-reader-text">必填</span></label>
				<input type="email" class="woocommerce-Input woocommerce-Input--text input-text" name="email" id="reg_email" autocomplete="email" value="" required aria-required="true" />			</p>
			<p class="woocommerce-form-row woocommerce-form-row--wide form-row form-row-wide">
				<label for="reg_password">密碼（至少 8 個字元）&nbsp;<span class="required" aria-hidden="true">*</span><span class="screen-reader-text">必填</span></label>
				<input type="password" class="woocommerce-Input woocommerce-Input--text input-text" name="password" id="reg_password" autocomplete="new-password" minlength="8" required aria-required="true" />
			</p>
			<div class="woocommerce-privacy-policy-text"><p>Your personal data will be used to support your experience throughout this website, to manage access to your account, and for other purposes described in our <a href="/?page_id=3" class="woocommerce-privacy-policy-link" target="_blank">隱私權政策</a>.</p>
</div>
			<p class="woocommerce-form-row form-row">
				<button type="submit" class="woocommerce-Button woocommerce-button button woocommerce-form-register__submit" name="register" value="註冊">註冊</button>
			</p>
		</form>
		</div>
` : ""}</div>`;
}

export function lostPasswordInner(notice = "") {
  return `<div class="woocommerce"><div class="woocommerce-notices-wrapper">${notice}</div>
<form method="post" class="woocommerce-ResetPassword lost_reset_password" action="/api/account/lost-password/" data-ajax="lost-password">
	<p>忘記密碼了嗎？請輸入你的使用者名稱或電子郵件地址。你將會透過電子郵件收到一個建立新密碼的連結。</p>
	<p class="woocommerce-form-row woocommerce-form-row--first form-row form-row-first">
		<label for="user_login">使用者名稱 或 電子郵件&nbsp;<span class="required" aria-hidden="true">*</span><span class="screen-reader-text">必填</span></label>
		<input class="woocommerce-Input woocommerce-Input--text input-text" type="text" name="user_login" id="user_login" autocomplete="username" required aria-required="true" />
	</p>
	<div class="clear"></div>
	<p class="woocommerce-form-row form-row">
		<input type="hidden" name="form" value="lost-password" />
		<button type="submit" class="woocommerce-Button button" value="重設密碼">重設密碼</button>
	</p>
</form>
</div>`;
}

const STATUS: Record<string, string> = {
  pending: "待付款",
  processing: "處理中",
  "on-hold": "保留",
  completed: "完成",
  cancelled: "已取消",
  refunded: "已退款",
  failed: "失敗",
  "checkout-draft": "草稿",
};

function nav(active: string) {
  const items = [
    ["dashboard", "控制台", "/my-account-2/"],
    ["orders", "訂單", "/my-account-2/orders/"],
    ["customer-logout", "登出", "/api/account/logout/"],
  ];
  return `<nav class="woocommerce-MyAccount-navigation" aria-label="帳號頁面">
	<ul>${items
    .map(([k, t, u]) => `<li class="woocommerce-MyAccount-navigation-link woocommerce-MyAccount-navigation-link--${k}${k === active ? " is-active" : ""}"><a href="${u}"${k === active ? ' aria-current="page"' : ""}>${t}</a></li>`)
    .join("")}</ul>
</nav>`;
}

export type OrderRow = { id: number; order_number: string | null; date_created: string; status: string; total: string | number; item_count: number };

function fmtDate(s: string) {
  const d = new Date(new Date(s).getTime() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

export function accountInner(email: string, active: "dashboard" | "orders" | "view-order", orders: OrderRow[], detail?: string) {
  let content = "";
  if (active === "dashboard") {
    content = `<p>你好 <strong>${esc(email)}</strong>（不是 <strong>${esc(email)}</strong>？<a href="/api/account/logout/">登出</a>）</p>
<p>你可以在帳號控制台中查看<a href="/my-account-2/orders/">近期訂單</a>。</p>`;
  } else if (active === "orders") {
    content = orders.length
      ? `<table class="woocommerce-orders-table woocommerce-MyAccount-orders shop_table shop_table_responsive my_account_orders account-orders-table">
		<thead><tr><th class="woocommerce-orders-table__header"><span class="nobr">訂單</span></th><th class="woocommerce-orders-table__header"><span class="nobr">日期</span></th><th class="woocommerce-orders-table__header"><span class="nobr">狀態</span></th><th class="woocommerce-orders-table__header"><span class="nobr">總計</span></th><th class="woocommerce-orders-table__header"><span class="nobr">動作</span></th></tr></thead>
		<tbody>${orders
      .map(
        (o) => `<tr class="woocommerce-orders-table__row woocommerce-orders-table__row--status-${esc(o.status)} order"><th class="woocommerce-orders-table__cell" scope="row" data-title="訂單"><a href="/my-account-2/view-order/${o.id}/">#${esc(o.order_number || o.id)}</a></th><td class="woocommerce-orders-table__cell" data-title="日期"><time datetime="${esc(o.date_created)}">${fmtDate(o.date_created)}</time></td><td class="woocommerce-orders-table__cell" data-title="狀態">${STATUS[o.status] || esc(o.status)}</td><td class="woocommerce-orders-table__cell" data-title="總計">${priceHtml(o.total, false)} 共 ${o.item_count} 件商品</td><td class="woocommerce-orders-table__cell" data-title="動作"><a href="/my-account-2/view-order/${o.id}/" class="woocommerce-button button view">查看</a></td></tr>`,
      )
      .join("")}</tbody></table>`
      : `<div class="woocommerce-message woocommerce-message--info woocommerce-Message woocommerce-Message--info woocommerce-info">尚未建立任何訂單。<a class="woocommerce-Button button" href="/">瀏覽商品</a></div>`;
  } else {
    content = detail || "";
  }
  return `<div class="woocommerce">${nav(active === "view-order" ? "orders" : active)}<div class="woocommerce-MyAccount-content"><div class="woocommerce-notices-wrapper"></div>${content}</div></div>`;
}

export { STATUS as ORDER_STATUS_LABELS };
