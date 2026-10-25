/* 台灣宮廷藝術瓶 新站前台互動（取代舊站 Blocksy / WooCommerce / YITH / Chaty 的前端 JS） */
(function () {
  "use strict";
  var d = document;
  var body = d.body;
  function $(s, r) { return (r || d).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); }
  function on(ev, sel, fn) {
    d.addEventListener(ev, function (e) {
      var t = e.target && e.target.closest ? e.target.closest(sel) : null;
      if (t) fn(e, t);
    });
  }
  function post(url, data) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(data || {}),
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: "發生錯誤，請稍後再試。" }; }); });
  }

  /* ---------- 面板（手機選單、購物車抽屜、篩選、帳號彈窗） ---------- */
  var openPanel = null;
  function showPanel(id) {
    var p = d.getElementById(id);
    if (!p) return;
    if (openPanel && openPanel !== p) hidePanel();
    var beh = p.getAttribute("data-behaviour") || "right-side";
    body.setAttribute("data-panel", "in" + (beh.indexOf("left") > -1 ? ":left" : beh.indexOf("right") > -1 ? ":right" : ""));
    p.classList.add("active");
    p.setAttribute("aria-hidden", "false");
    openPanel = p;
    d.documentElement.style.setProperty("--scrollbar-width", window.innerWidth - d.documentElement.clientWidth + "px");
    d.documentElement.style.overflow = "hidden";
  }
  function hidePanel() {
    if (!openPanel) return;
    var p = openPanel;
    body.setAttribute("data-panel", "out");
    p.classList.remove("active");
    p.setAttribute("aria-hidden", "true");
    openPanel = null;
    setTimeout(function () {
      if (!openPanel) {
        body.removeAttribute("data-panel");
        d.documentElement.style.overflow = "";
        d.documentElement.style.removeProperty("--scrollbar-width");
      }
    }, 250);
  }
  on("click", "[data-toggle-panel], a.ct-offcanvas-trigger[href^='#'], a.ct-account-item[href='#account-modal'], [data-shortcut='filters_canvas']", function (e, t) {
    var id = (t.getAttribute("data-toggle-panel") || t.getAttribute("href") || "").replace("#", "");
    if (!id) return;
    e.preventDefault();
    showPanel(id);
  });
  on("click", ".ct-panel .ct-toggle-close", function (e) { e.preventDefault(); hidePanel(); });
  d.addEventListener("click", function (e) {
    if (openPanel && e.target === openPanel) hidePanel();
    if (openPanel && e.target.classList && e.target.classList.contains("ct-panel-inner") === false && e.target === openPanel.querySelector(".ct-panel-content") && openPanel.getAttribute("data-behaviour") === "modal") hidePanel();
  });
  d.addEventListener("keydown", function (e) { if (e.key === "Escape") { hidePanel(); closeLightbox(); } });

  /* ---------- 黏性頁首（Blocksy sticky: shrink） ---------- */
  function sticky() {
    $$("#header [data-sticky]").forEach(function (el) {
      var wrap = el.parentElement;
      var device = el.closest("[data-device]");
      if (!device || device.offsetParent === null) return;
      if (!wrap.style.minHeight) wrap.style.minHeight = el.offsetHeight + "px";
      var stuck = window.scrollY > 2;
      var cur = el.getAttribute("data-sticky") || "shrink";
      var base = cur.replace(/yes:?/, "").replace(/^:|:$/, "") || "shrink";
      if (stuck && cur.indexOf("yes") === -1) {
        el.setAttribute("data-sticky", "yes:" + base);
        $$("[data-transparent-row='yes']", el).forEach(function (r) { r.setAttribute("data-transparent-row", "no"); r.setAttribute("data-gp-transparent", "1"); });
      } else if (!stuck && cur.indexOf("yes") > -1) {
        el.setAttribute("data-sticky", base);
        $$("[data-gp-transparent]", el).forEach(function (r) { r.setAttribute("data-transparent-row", "yes"); });
      }
    });
    // 商品頁浮動加入購物車列
    var fb = $(".ct-floating-bar");
    if (fb) {
      var canvas = fb.closest(".ct-drawer-canvas");
      var summary = $(".entry-summary") || $(".product-entry-wrapper");
      var show = summary ? summary.getBoundingClientRect().bottom < 0 : window.scrollY > 400;
      if (canvas) canvas.setAttribute("data-floating-bar", show ? "yes" : "no");
    }
  }
  window.addEventListener("scroll", sticky, { passive: true });
  window.addEventListener("resize", function () { $$("#header .ct-sticky-container").forEach(function (w) { w.style.minHeight = ""; }); sticky(); });
  sticky();

  /* ---------- 數量 +/- ---------- */
  on("click", ".quantity[data-type] .ct-increase, .quantity[data-type] .ct-decrease", function (e, t) {
    var input = t.parentElement.querySelector("input.qty");
    if (!input) return;
    var v = parseInt(input.value || "0", 10) || 0;
    var min = input.min !== "" ? parseInt(input.min, 10) : 0;
    var max = input.max !== "" ? parseInt(input.max, 10) : Infinity;
    v = t.classList.contains("ct-increase") ? Math.min(max, v + 1) : Math.max(min, v - 1);
    input.value = v;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  /* ---------- 購物車 ---------- */
  function notice(container, msg, type) {
    if (!container) { if (msg) alert(msg); return; }
    container.innerHTML = msg ? '<div class="' + (type === "error" ? "woocommerce-error" : "woocommerce-message") + '" role="alert">' + msg + "</div>" : "";
  }
  function refreshCart(state) {
    if (!state) return;
    $$(".ct-dynamic-count-cart").forEach(function (el) { el.textContent = state.count; el.setAttribute("data-count", state.count); });
    $$(".ct-header-cart .ct-amount").forEach(function (el) { el.innerHTML = state.amount_html; });
    var mini = $("#woo-cart-panel .ct-panel-content-inner");
    if (mini && state.mini_html !== undefined) mini.innerHTML = state.mini_html;
  }
  // 公開頁為 ISR 快取，頁首購物車一律以空車輸出；有購物車標記時再取回實際狀態
  if (/(?:^|;\s*)gp_cart_mark=1/.test(d.cookie) && !$(".woocommerce-cart-form, .woocommerce-checkout")) {
    fetch("/api/cart/", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(refreshCart)
      .catch(function () {});
  }
  on("submit", "form.cart", function (e, form) {
    e.preventDefault();
    var btn = form.querySelector(".single_add_to_cart_button");
    if (btn && btn.classList.contains("disabled")) return;
    var data = { action: "add", product_id: (btn && btn.value) || (form.querySelector("[name='add-to-cart']") || {}).value, quantity: (form.querySelector("input.qty") || {}).value || 1 };
    var vid = form.querySelector("input.variation_id");
    if (vid) data.variation_id = vid.value;
    if (btn) btn.classList.add("loading");
    post("/api/cart/", data).then(function (r) {
      if (btn) btn.classList.remove("loading");
      var nw = $(".woocommerce-notices-wrapper");
      if (!r.ok) { notice(nw, r.error, "error"); if (nw) nw.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      refreshCart(r);
      if (typeof window.fbq === "function") window.fbq("track", "AddToCart");
      showPanel("woo-cart-panel");
    });
  });
  function cartAction(data, reload) {
    return post("/api/cart/", data).then(function (r) {
      if (!r.ok && r.error) alert(r.error);
      if (reload) { location.reload(); return; }
      refreshCart(r);
    });
  }
  // 側邊購物車：移除、數量
  on("click", "#woo-cart-panel a.remove_from_cart_button", function (e, a) {
    e.preventDefault();
    cartAction({ action: "remove", line: a.getAttribute("data-cart_item_key") }, !!$(".woocommerce-cart-form, .woocommerce-checkout"));
  });
  on("change", "#woo-cart-panel input.qty", function (e, input) {
    cartAction({ action: "update", line: input.getAttribute("data-line"), quantity: input.value }, !!$(".woocommerce-cart-form, .woocommerce-checkout"));
  });
  // 購物車頁
  on("click", ".woocommerce-cart-form a.remove", function (e, a) {
    e.preventDefault();
    cartAction({ action: "remove", line: a.getAttribute("data-cart_item_key") }, true);
  });
  function cartQtyChanged(e, input) {
    $$(".woocommerce-cart-form input.qty[data-line='" + input.getAttribute("data-line") + "']").forEach(function (o) { if (o !== input) o.value = input.value; });
    var b = $(".woocommerce-cart-form button[name='update_cart']");
    if (b) b.disabled = false;
  }
  on("change", ".woocommerce-cart-form input.qty", cartQtyChanged);
  on("input", ".woocommerce-cart-form input.qty", cartQtyChanged);
  on("click", ".woocommerce-cart-form button[name='update_cart']", function (e, b) {
    e.preventDefault();
    var seen = {};
    var jobs = [];
    $$(".woocommerce-cart-form td.product-quantity input.qty").forEach(function (i) {
      var l = i.getAttribute("data-line");
      if (seen[l]) return;
      seen[l] = 1;
      jobs.push(post("/api/cart/", { action: "update", line: l, quantity: i.value }));
    });
    b.disabled = true;
    Promise.all(jobs).then(function (rs) {
      var err = rs.filter(function (r) { return !r.ok; })[0];
      if (err) alert(err.error);
      location.reload();
    });
  });
  on("click", ".woocommerce-cart-form button[name='apply_coupon']", function (e) {
    e.preventDefault();
    var code = ($("#coupon_code") || {}).value || "";
    post("/api/cart/", { action: "coupon", code: code }).then(function (r) {
      var nw = $(".woocommerce-notices-wrapper");
      if (!r.ok) notice(nw, r.error || "請輸入優惠券代碼。", "error");
      else location.reload();
    });
  });
  on("click", "a.woocommerce-remove-coupon", function (e, a) {
    e.preventDefault();
    post("/api/cart/", { action: "remove_coupon", code: a.getAttribute("data-coupon") }).then(function () { location.reload(); });
  });
  on("click", "a.shipping-calculator-button", function (e) {
    e.preventDefault();
    var f = $(".shipping-calculator-form");
    if (f) f.style.display = f.style.display === "none" ? "" : "none";
  });
  // 運費為全台單一費率（滿額免運），計算器只需重新整理顯示
  on("submit", "form.woocommerce-shipping-calculator", function (e) { e.preventDefault(); location.reload(); });

  /* ---------- 結帳 ---------- */
  on("change", "#ship-to-different-address-checkbox", function (e, c) {
    var s = $(".shipping_address");
    if (s) s.style.display = c.checked ? "" : "none";
  });
  // 台灣地址連動（還原舊站 woomp twzipcode）：縣市 → 鄉鎮市區 → 郵遞區號，並同步隱藏的 *_state / *_city / *_postcode
  var twZip = null;
  function twData() {
    if (twZip) return twZip;
    var el = d.getElementById("tw-zip-data");
    try { twZip = el ? JSON.parse(el.textContent || "{}") : {}; } catch (_) { twZip = {}; }
    return twZip;
  }
  function twEls(p) {
    var form = d.querySelector("form.woocommerce-checkout") || d;
    return {
      county: form.querySelector("select[name='" + p + "_county']"),
      district: form.querySelector("select[name='" + p + "_district']"),
      zip: form.querySelector("input[name='" + p + "_zipcode']"),
      state: d.getElementById(p + "_state"),
      city: d.getElementById(p + "_city"),
      postcode: d.getElementById(p + "_postcode"),
    };
  }
  function twFillDistricts(x, county, selected) {
    if (!x.district) return;
    var list = (twData()[county]) || {};
    x.district.innerHTML = '<option value="">鄉鎮市區</option>';
    Object.keys(list).forEach(function (n) {
      var o = d.createElement("option");
      o.value = n; o.textContent = n;
      if (n === selected) o.selected = true;
      x.district.appendChild(o);
    });
  }
  function twSync(x) {
    var c = x.county ? x.county.value : "", n = x.district ? x.district.value : "";
    var z = c && n ? ((twData()[c] || {})[n] || "") : "";
    if (x.zip) x.zip.value = z;
    if (x.state) x.state.value = c;
    if (x.city) x.city.value = n;
    if (x.postcode) x.postcode.value = z;
  }
  on("change", "select.tw-county", function (e, s) {
    var x = twEls(s.getAttribute("data-prefix"));
    twFillDistricts(x, s.value, "");
    twSync(x);
  });
  on("change", "select.tw-district", function (e, s) {
    twSync(twEls(s.getAttribute("data-prefix")));
  });
  on("keyup", "input.tw-zipcode", function (e, s) {
    var x = twEls(s.getAttribute("data-prefix"));
    var v = (s.value || "").replace(/\D/g, "").slice(0, 3);
    if (x.postcode) x.postcode.value = s.value;
    if (v.length !== 3) return;
    var data = twData();
    for (var c in data) for (var n in data[c]) if (data[c][n] === v) {
      if (x.county) x.county.value = c;
      twFillDistricts(x, c, n);
      if (x.state) x.state.value = c;
      if (x.city) x.city.value = n;
      return;
    }
  });
  on("submit", "form.woocommerce-checkout", function (e, f) {
    var btn = $("#place_order", f);
    if (btn) { btn.disabled = true; btn.classList.add("loading"); }
    // 歸因資料（對應 wc_order_attribution_*）
    var box = $(".wc-order-attribution-inputs", f);
    if (box && !box.childNodes.length) {
      var ref = d.referrer || "(none)";
      var fields = { source_type: ref === "(none)" ? "typein" : "referral", referrer: ref, session_entry: sessionStorage.getItem("gp_entry") || location.href, user_agent: navigator.userAgent };
      Object.keys(fields).forEach(function (k) {
        var i = d.createElement("input");
        i.type = "hidden"; i.name = "wc_order_attribution_" + k; i.value = fields[k];
        box.appendChild(i);
      });
    }
  });
  try { if (!sessionStorage.getItem("gp_entry")) sessionStorage.setItem("gp_entry", location.href); } catch (err) {}

  // YITH 加價購彈窗
  var popup = $(".ywdpd_popup");
  if (popup && $(".woocommerce-checkout")) {
    var key = "gp_deal_closed_" + popup.getAttribute("data-rule");
    var closed = false;
    try { closed = !!sessionStorage.getItem(key); } catch (err) {}
    var place = function () {
      var w = popup.querySelector(".ywdpd_popup_wrapper");
      if (!w || popup.style.display === "none") return;
      w.style.position = "fixed";
      w.style.top = Math.max(0, (window.innerHeight - w.offsetHeight) / 2) + "px";
      w.style.left = Math.max(0, (window.innerWidth - w.offsetWidth) / 2) + "px";
    };
    if (!closed) setTimeout(function () { popup.style.display = "block"; place(); }, 600);
    window.addEventListener("resize", place);
    var close = function (e) { if (e) e.preventDefault(); popup.style.display = "none"; try { sessionStorage.setItem(key, "1"); } catch (err) {} };
    on("click", ".ywdpd_close, .ywdpd_no_thanks, .ywdpd_btn_confirm", close);
    popup.addEventListener("click", function (e) { if (e.target === popup) close(e); });
    on("click", ".ywdpd-add-deal", function (e, b) {
      e.preventDefault();
      b.classList.add("loading");
      post("/api/cart/", { action: "deal", rule: b.getAttribute("data-rule"), product_id: b.getAttribute("data-product"), quantity: 1 }).then(function (r) {
        if (!r.ok) { alert(r.error); b.classList.remove("loading"); return; }
        try { sessionStorage.setItem(key, "1"); } catch (err) {}
        location.reload();
      });
    });
  }

  /* ---------- 帳號（頁首彈窗、我的帳號頁） ---------- */
  on("click", ".ct-account-modal .ct-forgot-password", function (e) {
    e.preventDefault();
    var m = $(".ct-account-modal");
    $(".ct-login-form", m).classList.remove("active");
    $(".ct-forgot-password-form", m).classList.add("active");
  });
  on("click", ".ct-account-modal .ct-back-to-login", function (e) {
    e.preventDefault();
    var m = $(".ct-account-modal");
    $(".ct-forgot-password-form", m).classList.remove("active");
    $(".ct-login-form", m).classList.add("active");
  });
  function formData(f) {
    var o = {};
    new FormData(f).forEach(function (v, k) { o[k] = v; });
    return o;
  }
  function modalMsg(f, msg, ok) {
    var box = f.querySelector(".gp-form-msg");
    if (!box) { box = d.createElement("div"); box.className = "gp-form-msg"; f.insertBefore(box, f.firstChild); }
    box.innerHTML = msg ? '<div class="ct-form-notification' + (ok ? "" : "-error") + '">' + msg + "</div>" : "";
  }
  on("submit", "#account-modal form#loginform", function (e, f) {
    e.preventDefault();
    var data = formData(f);
    data.form = "header-login";
    var b = f.querySelector("button"); if (b) b.classList.add("ct-loading");
    post("/api/account/login/", data).then(function (r) {
      if (b) b.classList.remove("ct-loading");
      if (r.ok) location.href = r.redirect || "/my-account-2/";
      else modalMsg(f, r.error);
    });
  });
  on("submit", "#account-modal form#lostpasswordform", function (e, f) {
    e.preventDefault();
    post("/api/account/lost-password/", formData(f)).then(function (r) { modalMsg(f, r.message || r.error, r.ok); });
  });
  on("submit", "form[data-ajax]", function (e, f) {
    e.preventDefault();
    var kind = f.getAttribute("data-ajax");
    var data = formData(f);
    var b = f.querySelector("button[type='submit']"); if (b) b.disabled = true;
    post(f.getAttribute("action"), data).then(function (r) {
      if (b) b.disabled = false;
      var nw = $(".woocommerce-notices-wrapper");
      if (r.ok && r.redirect && kind !== "register") { location.href = r.redirect; return; }
      notice(nw, r.ok ? r.message || "完成" : r.error, r.ok ? "message" : "error");
      if (r.ok && kind === "register" && r.message === "註冊成功！") location.href = r.redirect;
      if (nw) nw.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  on("click", "a.gp-register-toggle", function (e) {
    var r = d.getElementById("customer_register");
    if (!r) return;
    e.preventDefault();
    r.style.display = r.style.display === "none" ? "" : "none";
    if (r.style.display === "") r.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  on("click", ".show-password-input", function (e, t) {
    var i = t.parentElement.querySelector("input");
    if (!i) return;
    i.type = i.type === "password" ? "text" : "password";
    t.classList.toggle("display-password");
  });

  /* ---------- 搜尋表單：記錄提交 ---------- */
  on("submit", "form.ct-search-form", function (e, f) {
    var s = (f.querySelector("input[name='s']") || {}).value || "";
    try {
      var blob = new Blob([JSON.stringify({ form: "search", s: s })], { type: "application/json" });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/forms/", blob);
    } catch (err) {}
  });

  /* ---------- 篩選（價格滑桿、分類搜尋） ---------- */
  $$(".ct-price-filter").forEach(function (box) {
    var inputs = $$("input[type=range]", box);
    if (inputs.length < 2) return;
    var mn = inputs[0], mx = inputs[1];
    var max = parseInt(mn.max, 10) || 1;
    function paint() {
      var a = Math.min(+mn.value, +mx.value), b = Math.max(+mn.value, +mx.value);
      var track = $(".ct-price-filter-range-track", box);
      if (track) { track.style.setProperty("--start", (a / max) * 100 + "%"); track.style.setProperty("--end", (b / max) * 100 + "%"); }
      var hmin = $(".ct-price-filter-range-handle-min", box), hmax = $(".ct-price-filter-range-handle-max", box);
      if (hmin) { hmin.style.insetInlineStart = (a / max) * 100 + "%"; hmin.querySelector(".ct-tooltip").textContent = "NT$" + a; }
      if (hmax) { hmax.style.insetInlineStart = (b / max) * 100 + "%"; hmax.querySelector(".ct-tooltip").textContent = "NT$" + b; }
      var tmin = $(".ct-price-filter-min", box), tmax = $(".ct-price-filter-max", box);
      if (tmin) tmin.textContent = "NT$" + a;
      if (tmax) tmax.textContent = "NT$" + b;
      return [a, b];
    }
    function go() {
      var v = paint();
      var u = new URL(location.href);
      u.pathname = box.getAttribute("data-base") || u.pathname.replace(/page\/\d+\/$/, "");
      u.searchParams.set("min_price", v[0]);
      u.searchParams.set("max_price", v[1]);
      location.href = u.toString();
    }
    [mn, mx].forEach(function (i) { i.addEventListener("input", paint); i.addEventListener("change", go); });
  });
  on("input", ".ct-filter-search input", function (e, i) {
    var q = i.value.trim().toLowerCase();
    var w = i.closest(".ct-filter-widget-wrapper");
    $$(".ct-filter-item", w).forEach(function (li) {
      li.style.display = !q || li.textContent.toLowerCase().indexOf(q) > -1 ? "" : "none";
    });
  });

  /* ---------- 無限捲動（Blocksy infinite_scroll） ---------- */
  function setupInfinite() {
    var nav = $("nav.ct-pagination[data-pagination='infinite_scroll']");
    if (!nav || !("IntersectionObserver" in window)) return;
    var loading = false;
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting || loading) return;
      var next = nav.querySelector("a.next");
      if (!next) { io.disconnect(); return; }
      loading = true;
      var helper = nav.querySelector(".ct-load-more-helper");
      if (helper) helper.classList.add("ct-loading");
      fetch(next.href, { credentials: "same-origin" })
        .then(function (r) { return r.text(); })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, "text/html");
          var list = $(".ct-products-container ul.products");
          var items = doc.querySelectorAll(".ct-products-container ul.products > li");
          Array.prototype.forEach.call(items, function (li) { list.appendChild(d.importNode(li, true)); });
          var nn = doc.querySelector("nav.ct-pagination");
          if (nn && nn.querySelector("a.next")) { nav.innerHTML = nn.innerHTML; }
          else {
            io.disconnect();
            $$(".page-numbers", nav).forEach(function (a) { a.parentNode.removeChild(a); });
            var h = nav.querySelector(".ct-load-more-helper");
            if (h) h.classList.remove("ct-loading");
            nav.classList.add("ct-last-page");
          }
          loading = false;
        })
        .catch(function () { loading = false; });
    }, { rootMargin: "200px" });
    io.observe(nav);
  }
  setupInfinite();

  /* ---------- 商品圖庫（flexy）與燈箱 ---------- */
  $$(".flexy-container").forEach(function (fc) {
    var items = $$(".flexy-item", fc);
    var pills = $$(".flexy-pills li", fc);
    var idx = 0;
    var track = $(".flexy-items", fc);
    track.style.display = "flex";
    track.style.transition = "transform .3s ease";
    items.forEach(function (it) { it.style.flex = "0 0 100%"; it.style.maxWidth = "100%"; });
    var view = $(".flexy-view", fc);
    if (view) view.style.overflow = "hidden";
    function go(i) {
      idx = (i + items.length) % items.length;
      track.style.transform = "translateX(" + -100 * idx + "%)";
      pills.forEach(function (p, j) { p.classList.toggle("active", j === idx); });
      fc.setAttribute("data-current", idx);
    }
    $$(".flexy > .flexy-arrow-prev", fc).forEach(function (b) { b.addEventListener("click", function () { go(idx - 1); }); });
    $$(".flexy > .flexy-arrow-next", fc).forEach(function (b) { b.addEventListener("click", function () { go(idx + 1); }); });
    pills.forEach(function (p, j) { p.addEventListener("click", function () { go(j); }); });
    go(0);
  });

  var lb = null, lbImgs = [], lbIdx = 0;
  function closeLightbox() {
    if (!lb) return;
    lb.parentNode.removeChild(lb);
    lb = null;
    body.classList.remove("gp-lightbox-open");
    if (d.fullscreenElement) d.exitFullscreen().catch(function () {});
  }
  function renderLb() {
    var img = lb.querySelector("img");
    img.classList.remove("zoomed");
    img.src = lbImgs[lbIdx];
    lb.querySelector(".gp-lb-count").textContent = lbIdx + 1 + " / " + lbImgs.length;
  }
  function openLightbox(srcs, i) {
    lbImgs = srcs; lbIdx = i || 0;
    lb = d.createElement("div");
    lb.className = "gp-lightbox pswp pswp--open";
    lb.setAttribute("role", "dialog");
    lb.innerHTML = '<span class="gp-lb-count"></span><img alt="">' +
      '<div class="gp-lb-bar"><button class="gp-lb-share" title="分享" aria-label="分享">⤴</button><button class="gp-lb-fs" title="切換為全螢幕" aria-label="切換為全螢幕">⛶</button><button class="gp-lb-zoom" title="放大/縮小" aria-label="放大/縮小">⊕</button><button class="gp-lb-close" title="關閉 (Esc)" aria-label="關閉 (Esc)">✕</button></div>' +
      '<div class="gp-lb-share"><a target="_blank" rel="noopener" data-net="fb">分享到 Facebook</a><a target="_blank" rel="noopener" data-net="line">分享到 LINE</a><a target="_blank" rel="noopener" data-net="dl" download>下載圖片</a></div>' +
      (srcs.length > 1 ? '<button class="gp-lb-prev" title="上一步 (向左箭頭)" aria-label="上一步 (向左箭頭)">‹</button><button class="gp-lb-next" title="下一步 (向右箭頭)" aria-label="下一步 (向右箭頭)">›</button>' : "");
    body.appendChild(lb);
    body.classList.add("gp-lightbox-open");
    renderLb();
    lb.addEventListener("click", function (e) {
      var t = e.target;
      if (t === lb) return closeLightbox();
      if (t.closest(".gp-lb-close")) return closeLightbox();
      if (t.closest(".gp-lb-prev")) { lbIdx = (lbIdx - 1 + lbImgs.length) % lbImgs.length; return renderLb(); }
      if (t.closest(".gp-lb-next")) { lbIdx = (lbIdx + 1) % lbImgs.length; return renderLb(); }
      if (t.closest(".gp-lb-zoom") || t.tagName === "IMG") return lb.querySelector("img").classList.toggle("zoomed");
      if (t.closest(".gp-lb-fs")) { if (d.fullscreenElement) d.exitFullscreen(); else if (lb.requestFullscreen) lb.requestFullscreen(); return; }
      if (t.closest("button.gp-lb-share")) {
        var box = lb.querySelector("div.gp-lb-share");
        var page = encodeURIComponent(location.href);
        box.querySelector("[data-net=fb]").href = "https://www.facebook.com/sharer/sharer.php?u=" + page;
        box.querySelector("[data-net=line]").href = "https://social-plugins.line.me/lineit/share?url=" + page;
        box.querySelector("[data-net=dl]").href = lbImgs[lbIdx];
        box.classList.toggle("open");
      }
    });
  }
  d.addEventListener("keydown", function (e) {
    if (!lb) return;
    if (e.key === "ArrowLeft") { lbIdx = (lbIdx - 1 + lbImgs.length) % lbImgs.length; renderLb(); }
    if (e.key === "ArrowRight") { lbIdx = (lbIdx + 1) % lbImgs.length; renderLb(); }
  });
  on("click", ".woocommerce-product-gallery__trigger, .woocommerce-product-gallery figure.ct-media-container", function (e, t) {
    var g = t.closest(".woocommerce-product-gallery");
    if (!g) return;
    e.preventDefault();
    var figs = $$(".flexy-item figure[data-src], .ct-product-gallery-container > figure[data-src]", g);
    var srcs = figs.map(function (f) { return f.getAttribute("data-src"); });
    var fc = $(".flexy-container", g);
    var i = t.tagName === "FIGURE" ? figs.indexOf(t) : fc ? parseInt(fc.getAttribute("data-current") || "0", 10) : 0;
    if (srcs.length) openLightbox(srcs, Math.max(0, i));
  });

  /* ---------- 可變商品 ---------- */
  $$("form.variations_form").forEach(function (f) {
    var vars = [];
    try { vars = JSON.parse(f.getAttribute("data-product_variations") || "[]"); } catch (err) {}
    var btn = f.querySelector(".single_add_to_cart_button");
    var out = f.querySelector(".single_variation");
    var vid = f.querySelector("input.variation_id");
    function match() {
      var sel = {};
      var all = true;
      $$("select[data-attribute_name]", f).forEach(function (s) { sel[s.getAttribute("data-attribute_name")] = s.value; if (!s.value) all = false; });
      var v = all ? vars.filter(function (x) {
        return Object.keys(sel).every(function (k) { var want = x.attributes[k] || x.attributes[k.replace("attribute_", "")] || ""; return !want || want === sel[k]; });
      })[0] : null;
      vid.value = v ? v.variation_id : 0;
      btn.classList.toggle("disabled", !v || !v.is_in_stock);
      out.innerHTML = v ? '<div class="woocommerce-variation-price"><span class="price">' + v.price_html + "</span></div>" + (v.is_in_stock ? "" : '<p class="stock out-of-stock">缺貨</p>') : "";
    }
    f.addEventListener("change", match);
    match();
  });

  /* ---------- Elementor：背景圖延遲載入、動畫 ---------- */
  $$(".e-con, .elementor-section").forEach(function (el) { el.classList.add("e-lazyloaded"); });

  /* ---------- GreenShift 計數器（.gs-counter data-start / data-end / data-duration）：進入畫面時由起始值數到結束值 ---------- */
  var counters = $$(".gs-counter[data-end]");
  function runCounter(el) {
    if (el.getAttribute("data-gp-done")) return;
    el.setAttribute("data-gp-done", "1");
    var from = parseFloat(el.getAttribute("data-start") || "0") || 0;
    var to = parseFloat(el.getAttribute("data-end") || "0") || 0;
    var dur = Math.max(0.1, parseFloat(el.getAttribute("data-duration") || "2") || 2) * 1000;
    var dec = ((el.getAttribute("data-end") || "").split(".")[1] || "").length;
    var t0 = null;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur);
      var eased = 1 - Math.pow(1 - k, 3);
      el.textContent = (from + (to - from) * eased).toFixed(dec);
      if (k < 1) window.requestAnimationFrame(step);
    }
    window.requestAnimationFrame(step);
  }
  if (counters.length) {
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { runCounter(e.target); io.unobserve(e.target); } });
      }, { threshold: 0.2 });
      counters.forEach(function (c) { io.observe(c); });
    } else {
      counters.forEach(function (c) { c.textContent = c.getAttribute("data-end"); });
    }
  }
})();
