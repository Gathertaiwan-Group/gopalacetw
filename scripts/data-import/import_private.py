#!/usr/bin/env python3
"""第三階段：WordPress 私有資料 → site_gopalacetw（顧客、訂單、優惠券、YITH 規則、選單、表單定義、設定）。

用法（資料目錄在 repo 之外，含個資；本腳本只輸出筆數與總額）：
  source ~/.config/gather-migrate/env
  python3 -I scripts/data-import/import_private.py ~/gather-migrate/_db/gopalacetw/tables [--dry-run]

冪等：以 WordPress 原始 ID 為主鍵 upsert；重跑會覆寫同 ID 資料，不影響新站自建的資料（ID ≥ 1000000）。
"""
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

SCHEMA = "site_gopalacetw"
PROJECT = "ozwftlkgqmewtadypsfi"
OLD_HOST_RE = re.compile(r"^https?://go\.palacetwshop\.com", re.I)


# ---------------------------------------------------------------- PHP unserialize（最小實作）
def php_unserialize(s):
    if not isinstance(s, str) or not re.match(r"^(a|s|i|d|b|N|O):", s):
        return s
    data = s.encode("utf-8")
    pos = 0

    def read_until(ch):
        nonlocal pos
        end = data.index(ch.encode(), pos)
        v = data[pos:end]
        pos = end + 1
        return v.decode()

    def parse():
        nonlocal pos
        t = chr(data[pos])
        pos += 2
        if t == "N":
            return None
        if t == "b":
            return read_until(";") == "1"
        if t == "i":
            return int(read_until(";"))
        if t == "d":
            return float(read_until(";"))
        if t == "s":
            n = int(read_until(":"))
            pos += 1  # "
            v = data[pos : pos + n].decode("utf-8")
            pos += n + 2  # ";
            return v
        if t == "a":
            n = int(read_until(":"))
            pos += 1  # {
            out = {}
            for _ in range(n):
                k = parse()
                out[k] = parse()
            pos += 1  # }
            if list(out.keys()) == list(range(len(out))):
                return list(out.values())
            return out
        raise ValueError("unsupported php type " + t)

    try:
        v = parse()
        # 雙重序列化（s:N:"a:..."）
        if isinstance(v, str) and re.match(r"^(a|O):\d+:", v):
            return php_unserialize(v)
        return v
    except Exception:
        return s


# ---------------------------------------------------------------- helpers
def load(dirpath, name):
    p = os.path.join(dirpath, name + ".jsonl")
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def gmt(s):
    if not s or s.startswith("0000"):
        return None
    return s.replace(" ", "T") + "+00:00"


def unix(v):
    if v in (None, ""):
        return None
    try:
        return datetime.fromtimestamp(int(v), tz=timezone.utc).isoformat()
    except ValueError:
        return None


def num(v, default=0.0):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return default


def opt_int(v):
    try:
        return int(v) if v not in (None, "") else None
    except ValueError:
        return None


def ids(v):
    if not v:
        return []
    if isinstance(v, list):
        return [int(x) for x in v if str(x).isdigit()]
    return [int(x) for x in str(v).split(",") if x.strip().isdigit()]


def new_url(u):
    if not u:
        return u
    return OLD_HOST_RE.sub("", u) or "/"


def run_sql(q):
    token = os.environ["SUPABASE_ACCESS_TOKEN"]
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "GatherMigrator/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        # 錯誤訊息可能夾帶資料列內容（DETAIL: Failing row contains ...）→ 只保留第一行、去掉資料
        msg = e.read().decode("utf-8", "replace")
        msg = re.split(r"DETAIL|Failing row|\\n", msg)[0][:300]
        raise SystemExit(f"SQL 失敗：HTTP {e.code} {msg}")


def jlit(obj):
    tag = "j" + secrets.token_hex(6)
    return f"${tag}${json.dumps(obj, ensure_ascii=False)}${tag}$::jsonb"


def upsert(table, rows, conflict="id", update_cols=None):
    if not rows:
        return ""
    cols = sorted({k for r in rows for k in r})
    for r in rows:
        for c in cols:
            r.setdefault(c, None)
    upd = update_cols or [c for c in cols if c != conflict]
    col_list = ", ".join(cols)
    sets = ", ".join(f"{c} = excluded.{c}" for c in upd)
    return (
        f"insert into {SCHEMA}.{table} ({col_list}) overriding system value\n"
        f"select {col_list} from jsonb_populate_recordset(null::{SCHEMA}.{table}, {jlit(rows)})\n"
        f"on conflict ({conflict}) do update set {sets};\n"
    )


# ---------------------------------------------------------------- main
def main():
    src = os.path.expanduser(sys.argv[1])
    dry = "--dry-run" in sys.argv
    L = lambda n: load(src, n)

    posts = {p["ID"]: p for p in L("wp_posts")}
    pm = defaultdict(dict)
    for m in L("wp_postmeta"):
        pm[m["post_id"]][m["meta_key"]] = m["meta_value"]
    terms = {t["term_id"]: t for t in L("wp_terms")}
    tt = L("wp_term_taxonomy")
    rel = defaultdict(list)
    for r in L("wp_term_relationships"):
        rel[r["object_id"]].append(r["term_taxonomy_id"])
    options = {o["option_name"]: o["option_value"] for o in L("wp_options")}

    existing = run_sql(
        f"select (select coalesce(json_agg(id),'[]') from {SCHEMA}.products) p,"
        f" (select coalesce(json_agg(id),'[]') from {SCHEMA}.product_variations) v,"
        f" (select coalesce(json_agg(json_build_object('id',id,'path',path)),'[]') from {SCHEMA}.posts) po"
    )[0]
    product_ids = set(existing["p"])
    variation_ids = set(existing["v"])
    post_paths = {x["id"]: x["path"] for x in existing["po"]}

    # ---------- 訂單（舊式 shop_order 與 HPOS wp_wc_orders 去重：以訂單 ID 為準，HPOS 優先）
    hpos = {o["id"]: o for o in L("wp_wc_orders")}
    legacy_orders = [p for p in posts.values() if p["post_type"] in ("shop_order", "shop_order_refund")]
    if hpos:
        raise SystemExit("此站資料含 HPOS wp_wc_orders，需擴充匯入邏輯")  # 本站 dump 無 HPOS 表
    stats = {s["order_id"]: s for s in L("wp_wc_order_stats")}
    items_by_order = defaultdict(list)
    for it in L("wp_woocommerce_order_items"):
        items_by_order[it["order_id"]].append(it)
    im = defaultdict(dict)
    for m in L("wp_woocommerce_order_itemmeta"):
        im[m["order_item_id"]][m["meta_key"]] = m["meta_value"]

    orders, order_items = [], []
    for p in legacy_orders:
        m = pm[p["ID"]]
        st = stats.get(p["ID"], {})
        b = lambda k: m.get("_billing_" + k) or None
        s = lambda k: m.get("_shipping_" + k) or None
        line_sub = 0.0
        ship_item = None
        for it in items_by_order[p["ID"]]:
            meta = im[it["order_item_id"]]
            if it["order_item_type"] == "line_item":
                qty = int(meta.get("_qty") or 1)
                pid = opt_int(meta.get("_product_id"))
                vid = opt_int(meta.get("_variation_id"))
                sub = num(meta.get("_line_subtotal"))
                line_sub += sub
                yw = php_unserialize(meta.get("_ywdpd_discounts")) if meta.get("_ywdpd_discounts") else None
                extra = {"wp_product_id": pid, "tax_class": meta.get("_tax_class") or ""}
                if meta.get("_reduced_stock"):
                    extra["reduced_stock"] = opt_int(meta.get("_reduced_stock"))
                if isinstance(yw, dict):
                    extra["ywdpd"] = yw
                    if "gift_products" in (yw.get("by") or []):
                        extra["is_gift"] = True
                        extra["discount_rule_id"] = yw.get("set_id")
                        extra["regular_price"] = yw.get("price_base")
                order_items.append(
                    {
                        "id": it["order_item_id"],
                        "order_id": p["ID"],
                        "item_type": "line_item",
                        "name": it["order_item_name"],
                        "product_id": pid if pid in product_ids else None,
                        "variation_id": vid if vid in variation_ids else None,
                        "quantity": qty,
                        "unit_price": round(sub / qty, 2) if qty else sub,
                        "subtotal": sub,
                        "subtotal_tax": num(meta.get("_line_subtotal_tax")),
                        "total": num(meta.get("_line_total")),
                        "total_tax": num(meta.get("_line_tax")),
                        "meta": extra,
                    }
                )
            elif it["order_item_type"] in ("shipping", "fee", "coupon", "tax"):
                cost = num(meta.get("cost") if it["order_item_type"] == "shipping" else meta.get("_line_total") or meta.get("discount_amount"))
                if it["order_item_type"] == "coupon":
                    cost = -abs(cost)
                if it["order_item_type"] == "shipping":
                    ship_item = (it, meta)
                order_items.append(
                    {
                        "id": it["order_item_id"],
                        "order_id": p["ID"],
                        "item_type": it["order_item_type"],
                        "name": it["order_item_name"],
                        "quantity": 1,
                        "unit_price": cost,
                        "subtotal": cost,
                        "total": cost,
                        "subtotal_tax": 0,
                        "total_tax": num(meta.get("total_tax")),
                        "meta": {
                            k: v
                            for k, v in {
                                "method_id": meta.get("method_id"),
                                "instance_id": meta.get("instance_id"),
                                "items": meta.get("項目"),
                            }.items()
                            if v not in (None, "")
                        },
                    }
                )
        status = p["post_status"][3:] if p["post_status"].startswith("wc-") else p["post_status"]
        attribution = {k[len("_wc_order_attribution_") :]: v for k, v in m.items() if k.startswith("_wc_order_attribution_")}
        orders.append(
            {
                "id": p["ID"],
                "order_number": str(p["ID"]),
                "order_key": m.get("_order_key"),
                "parent_id": p["post_parent"] or None,
                "type": p["post_type"],
                "status": status,
                "currency": m.get("_order_currency") or "TWD",
                "customer_id": st.get("customer_id") or None,
                "customer_ip": m.get("_customer_ip_address"),
                "customer_user_agent": m.get("_customer_user_agent"),
                **{f"billing_{k}": b(k) for k in ("first_name", "last_name", "company", "address_1", "address_2", "city", "state", "postcode", "country", "email", "phone")},
                **{f"shipping_{k}": s(k) for k in ("first_name", "last_name", "company", "address_1", "address_2", "city", "state", "postcode", "country", "phone")},
                "payment_method": m.get("_payment_method"),
                "payment_method_title": m.get("_payment_method_title"),
                "transaction_id": m.get("_transaction_id") or None,
                "shipping_method": f"{ship_item[1].get('method_id')}:{ship_item[1].get('instance_id')}" if ship_item else None,
                "shipping_method_title": ship_item[0]["order_item_name"] if ship_item else None,
                "subtotal": round(line_sub, 2),
                "discount_total": num(m.get("_cart_discount")),
                "shipping_total": num(m.get("_order_shipping")),
                "fee_total": 0,
                "tax_total": round(num(m.get("_order_tax")) + num(m.get("_order_shipping_tax")), 2),
                "total": num(m.get("_order_total")),
                "customer_note": p["post_excerpt"] or None,
                "created_via": m.get("_created_via") or "checkout",
                "attribution": attribution,
                "meta": {
                    "source": "wp_import",
                    "wp_customer_user": opt_int(m.get("_customer_user")),
                    "order_version": m.get("_order_version"),
                    "prices_include_tax": m.get("_prices_include_tax"),
                    "ecpay": {k[len("_ecpay_") :]: v for k, v in m.items() if k.startswith("_ecpay_")},
                    "recorded_sales": m.get("_recorded_sales"),
                    "order_stock_reduced": m.get("_order_stock_reduced"),
                },
                "date_created": gmt(p["post_date_gmt"]),
                "date_paid": unix(m.get("_date_paid")) or unix(m.get("_paid_date") if str(m.get("_paid_date", "")).isdigit() else None),
                "date_completed": unix(m.get("_date_completed")),
            }
        )

    # 訂單備註（wp_comments.comment_type = order_note）
    comments = L("wp_comments")
    order_ids = {o["id"] for o in orders}
    notes = []
    public_comments = []
    for c in comments:
        if c["comment_type"] == "order_note" and c["comment_post_ID"] in order_ids:
            notes.append(
                {
                    "id": c["comment_ID"],
                    "order_id": c["comment_post_ID"],
                    "note": c["comment_content"],
                    "is_customer_note": False,
                    "added_by": c["comment_author"] or "system",
                    "created_at": gmt(c["comment_date_gmt"]),
                }
            )
        elif c["comment_type"] in ("comment", "review", "") and c["comment_post_ID"] not in order_ids:
            public_comments.append(c)
    if public_comments:
        raise SystemExit("此站有公開留言，需擴充匯入邏輯")  # 本站 dump 只有 order_note

    # ---------- 顧客（wc_customer_lookup；本站全為訪客結帳，無 WP 顧客帳號）
    customers = []
    for c in L("wp_wc_customer_lookup"):
        mine = sorted([o for o in orders if o["customer_id"] == c["customer_id"] and o["type"] == "shop_order"], key=lambda o: o["date_created"])
        last = mine[-1] if mine else {}
        addr = lambda pre: {
            k: last.get(f"{pre}_{k}") or ""
            for k in ("first_name", "last_name", "company", "address_1", "address_2", "city", "state", "postcode", "country", "phone")
            + (("email",) if pre == "billing" else ())
        }
        paid = [o for o in mine if o["status"] in ("processing", "completed")]
        customers.append(
            {
                "id": c["customer_id"],
                "auth_user_id": None,
                "email": (c["email"] or "").lower() or None,
                "username": c["username"] or None,
                "first_name": c["first_name"] or None,
                "last_name": c["last_name"] or None,
                "display_name": " ".join(x for x in (c["last_name"], c["first_name"]) if x) or None,
                "role": "customer",
                "billing": addr("billing") if last else {},
                "shipping": addr("shipping") if last else {},
                "is_paying_customer": bool(paid),
                "orders_count": len(mine),
                "total_spent": round(sum(o["total"] for o in paid), 2),
                "meta": {
                    "source": "wp_import",
                    "wc_customer_lookup_id": c["customer_id"],
                    "wp_user_id": c["user_id"],
                    "guest": c["user_id"] is None,
                    "date_last_active": gmt(c["date_last_active"]),
                    "country": c["country"],
                },
                "date_registered": gmt(c["date_registered"]),
            }
        )

    # ---------- 優惠券
    coupons = []
    for p in posts.values():
        if p["post_type"] != "shop_coupon":
            continue
        m = pm[p["ID"]]
        coupons.append(
            {
                "id": p["ID"],
                "code": p["post_title"].strip().lower(),
                "status": p["post_status"],
                "description": p["post_excerpt"] or "",
                "discount_type": m.get("discount_type") or "fixed_cart",
                "amount": num(m.get("coupon_amount")),
                "date_expires": unix(m.get("date_expires")),
                "usage_count": int(m.get("usage_count") or 0),
                "usage_limit": opt_int(m.get("usage_limit")) or None,
                "usage_limit_per_user": opt_int(m.get("usage_limit_per_user")) or None,
                "limit_usage_to_x_items": opt_int(m.get("limit_usage_to_x_items")) or None,
                "individual_use": m.get("individual_use") == "yes",
                "free_shipping": m.get("free_shipping") == "yes",
                "exclude_sale_items": m.get("exclude_sale_items") == "yes",
                "product_ids": ids(m.get("product_ids")),
                "excluded_product_ids": ids(m.get("exclude_product_ids")),
                "product_categories": ids(php_unserialize(m.get("product_categories"))),
                "excluded_product_categories": ids(php_unserialize(m.get("exclude_product_categories"))),
                "minimum_amount": num(m.get("minimum_amount"), None) if m.get("minimum_amount") else None,
                "maximum_amount": num(m.get("maximum_amount"), None) if m.get("maximum_amount") else None,
                "email_restrictions": php_unserialize(m.get("customer_email")) or [],
                "used_by": [],
                "meta": {"source": "wp_import"},
                "created_at": gmt(p["post_date_gmt"]),
            }
        )

    # ---------- YITH Dynamic Pricing（ywdpd_discount）
    rules = []
    for p in posts.values():
        if p["post_type"] != "ywdpd_discount":
            continue
        m = {k: v for k, v in pm[p["ID"]].items() if not k.startswith("_edit_")}
        raw = {k.lstrip("_"): php_unserialize(v) for k, v in m.items()}
        mode = raw.get("discount_mode")
        sched = raw.get("schedule_discount_mode") or {}
        r_rules, conditions, apply_to = [], [], {}
        if mode == "gift_products":
            n = raw.get("n_items_in_cart") or {}
            r_rules = [
                {
                    "gift_mode": raw.get("gift_mode"),  # cart_item = 依購物車件數；cart_subtotal = 依小計
                    "n_items": {"condition": n.get("condition"), "value": opt_int(n.get("n_items"))},
                    "subtotal": num(raw.get("gift_subtotal")),
                    "product_ids": ids(raw.get("gift_product_selection")),
                    "amount_allowed": opt_int(raw.get("amount_gift_product_allowed")) or 1,
                    "auto_add": str(raw.get("add_gift_automatically")) == "1",
                    "modal_text": raw.get("text_in_modal_gift"),
                }
            ]
            apply_to = {"rule_for": raw.get("rule_for"), "exclude": raw.get("exclude_rule_for") if str(raw.get("active_exclude")) == "1" else None}
        elif mode == "last_deals":
            d = raw.get("deal_discount") or {}
            r_rules = [
                {
                    "product_id": (ids(raw.get("deal_product_selection")) or [None])[0],
                    "product_ids": ids(raw.get("deal_product_selection")),
                    "discount_type": d.get("discount_type"),
                    "discount_amount": num(d.get("discount_amount")),
                    "max_qty": opt_int((raw.get("deal_max_unit_product_to_add") or {}).get("deal_max_unit_product_to_add")),
                    "total_products": opt_int((raw.get("deal_total_product_to_add") or {}).get("deal_total_product_to_add")),
                    "title": re.sub(r"<[^>]+>", "", raw.get("deal_note") or "").strip() or p["post_title"],
                    "layout": raw.get("deal_layout"),
                    "show": raw.get("show_deal"),
                }
            ]
        elif mode == "cart":
            conditions = raw.get("cart_discount_rules") or []
            r_rules = [{"discount": raw.get("discount_rule"), "free_shipping": str(raw.get("allow_free_shipping")) == "1", "notice": raw.get("cart_notice")}]
        rules.append(
            {
                "id": p["ID"],
                "slug": p["post_name"],
                "title": p["post_title"],
                "status": p["post_status"],
                "active": raw.get("active") == "yes",
                "discount_mode": mode,
                "priority": opt_int(raw.get("priority")),
                "schedule_from": (sched.get("schedule_from") or None) if raw.get("is_scheduled") == "yes" else None,
                "schedule_to": (sched.get("schedule_to") or None) if raw.get("is_scheduled") == "yes" else None,
                "user_rules": {"user_rules": raw.get("user_rules") or "everyone", "exclude": raw.get("user_rule_exclude") if str(raw.get("enable_user_rule_exclude")) == "1" else None},
                "apply_to": apply_to,
                "conditions": conditions,
                "rules": r_rules,
                "raw_meta": raw,
                "details_status": "imported",
                "published_at": gmt(p["post_date_gmt"]),
                "modified_at": gmt(p["post_modified_gmt"]),
            }
        )

    # ---------- WordPress 選單（nav_menu + nav_menu_item）
    theme = options.get("stylesheet") or "blocksy-child"
    mods = php_unserialize(options.get(f"theme_mods_{theme}") or "") or {}
    locs = (mods.get("nav_menu_locations") if isinstance(mods, dict) else None) or {}
    loc_of = defaultdict(list)
    for k, v in locs.items():
        if v:
            loc_of[int(v)].append(k)
    tt_by_id = {t["term_taxonomy_id"]: t for t in tt}
    menus, menu_items = [], []
    nav = [t for t in tt if t["taxonomy"] == "nav_menu"]
    for t in nav:
        term = terms[t["term_id"]]
        wp_locs = loc_of.get(t["term_id"], [])
        location = "header" if ("menu_1" in wp_locs or "menu_mobile" in wp_locs) else ("footer" if "footer" in wp_locs else None)
        menus.append(
            {
                "id": t["term_id"],
                "slug": term["slug"],
                "name": term["name"],
                "location": location,
                "source": "wp_nav_menu",
                "meta": {"wp_locations": wp_locs, "theme": theme, "item_count": t["count"]},
            }
        )
    menu_of_item = {}
    for p in posts.values():
        if p["post_type"] == "nav_menu_item":
            for ttid in rel[p["ID"]]:
                if tt_by_id.get(ttid, {}).get("taxonomy") == "nav_menu":
                    menu_of_item[p["ID"]] = tt_by_id[ttid]["term_id"]
    for pid, menu_id in menu_of_item.items():
        p = posts[pid]
        m = pm[pid]
        typ, obj, oid = m.get("_menu_item_type"), m.get("_menu_item_object"), opt_int(m.get("_menu_item_object_id"))
        title = p["post_title"]
        url = m.get("_menu_item_url") or ""
        if typ == "taxonomy" and oid in terms:
            title = title or terms[oid]["name"]
            base = {"product_cat": "product-category", "product_tag": "product-tag", "category": "category", "post_tag": "tag"}.get(obj, obj)
            url = f"/{base}/{terms[oid]['slug']}/"
        elif typ == "post_type" and oid in posts:
            title = title or posts[oid]["post_title"]
            url = post_paths.get(oid) or f"/{posts[oid]['post_name']}/"
        else:
            url = new_url(url) or "#"
        classes = [c for c in (php_unserialize(m.get("_menu_item_classes")) or []) if c]
        parent = opt_int(m.get("_menu_item_menu_item_parent")) or None
        menu_items.append(
            {
                "id": pid,
                "menu_id": menu_id,
                "parent_id": parent,
                "position": p["menu_order"],
                "title": title,
                "url": url,
                "object_type": obj,
                "object_id": oid if typ != "custom" else None,
                "target": m.get("_menu_item_target") or None,
                "rel": m.get("_menu_item_xfn") or None,
                "aria_label": None,
                "css_classes": classes,
                "meta": {"wp_type": typ, "wp_title": p["post_title"], "wp_url": m.get("_menu_item_url") or None},
            }
        )

    # ---------- 表單定義（Fluent Forms / WPForms；本站無任何提交紀錄）
    forms = []
    for f in L("wp_fluentform_forms"):
        forms.append({"slug": f"fluentform-{f['id']}", "name": f["title"], "kind": "contact", "fields": [], "settings": {"wp_form_fields": json.loads(f["form_fields"]) if f.get("form_fields") else None}, "source": "wp_fluentform", "is_active": False})
    for p in posts.values():
        if p["post_type"] == "wpforms":
            try:
                content = json.loads(p["post_content"])
            except ValueError:
                content = None
            forms.append({"slug": f"wpforms-{p['ID']}", "name": p["post_title"], "kind": "contact", "fields": [], "settings": {"wp_form": content}, "source": "wpforms", "is_active": False})
    submissions_src = sum(len(L(t)) for t in ("wp_fluentform_submissions", "wp_wpforms_entries", "wp_e_submissions", "wp_chaty_contact_form_leads"))

    # ---------- 設定（WooCommerce 運費／稅／幣別）
    flat = php_unserialize(options.get("woocommerce_flat_rate_1_settings") or "") or {}
    zones = L("wp_woocommerce_shipping_zones")
    shipping = {
        "source": "wp_db",
        "zones": [{"id": z["zone_id"], "name": z["zone_name"], "methods": [{"id": f"{x['method_id']}:{x['instance_id']}", "enabled": bool(x["is_enabled"])} for x in L("wp_woocommerce_shipping_zone_methods") if x["zone_id"] == z["zone_id"]]} for z in zones],
        "methods": [{"id": "flat_rate:1", "cost": num(flat.get("cost"), 150), "title": flat.get("title"), "cost_requires": flat.get("cost_requires"), "min_amount": num(flat.get("min_amount"), None), "ignore_discounts": flat.get("ignore_discounts") == "yes"}],
        "free_shipping_min_amount": num(flat.get("min_amount"), 6000),
        "shipping_progress_bar": True,
    }
    tax = {"calc_taxes": options.get("woocommerce_calc_taxes") == "yes", "prices_include_tax": options.get("woocommerce_prices_include_tax") == "yes", "tax_classes": [t["name"] for t in L("wp_wc_tax_rate_classes")], "source": "wp_db"}

    # ---------- 組 SQL
    sql = ["begin;"]
    # 舊的 HTML 推測選單（ID 1000001）由真正的 WP 選單 56 取代
    sql.append(f"delete from {SCHEMA}.menus where source = 'html_snapshot' and slug = 'main-menu';")
    sql.append(upsert("menus", menus))
    sql.append(upsert("menu_items", sorted(menu_items, key=lambda x: (x["parent_id"] is not None, x["id"]))))
    sql.append(upsert("customers", customers, update_cols=[c for c in customers[0] if c not in ("id", "auth_user_id")] if customers else None))
    sql.append(upsert("orders", sorted(orders, key=lambda o: (o["parent_id"] is not None, o["id"]))))
    sql.append(upsert("order_items", order_items))
    sql.append(upsert("order_notes", notes))
    sql.append(upsert("coupons", coupons))
    sql.append(upsert("discount_rules", rules))
    if forms:
        sql.append(upsert("forms", forms, conflict="slug"))
    sql.append(f"update {SCHEMA}.settings set value = value || {jlit(shipping)}, source = 'wp_db' where key = 'shipping';")
    sql.append(f"insert into {SCHEMA}.settings (key, value, is_public, source) values ('tax', {jlit(tax)}, true, 'wp_db') on conflict (key) do update set value = excluded.value, source = excluded.source;")
    sql.append(
        f"update {SCHEMA}.settings set value = {jlit({'note': '第三階段私有資料已匯入（scripts/data-import/import_private.py）', 'imported_at': datetime.now(timezone.utc).isoformat(), 'media_hidden_attachment_ids': [1157, 1995]})} where key = 'private_data_pending';"
    )
    # 序號：確保新站自建資料仍從 1000000 起
    sql.append("commit;")
    body = "\n".join(x for x in sql if x)

    summary = {
        "orders": len(orders),
        "order_items": len(order_items),
        "order_items_line": sum(1 for i in order_items if i["item_type"] == "line_item"),
        "order_notes": len(notes),
        "orders_total_sum": round(sum(o["total"] for o in orders), 2),
        "orders_by_status": {s: sum(1 for o in orders if o["status"] == s) for s in sorted({o["status"] for o in orders})},
        "customers": len(customers),
        "coupons": len(coupons),
        "discount_rules": len(rules),
        "menus": len(menus),
        "menu_items": len(menu_items),
        "forms_defs": len(forms),
        "form_submissions_source": submissions_src,
        "public_comments_source": len(public_comments),
    }
    print(json.dumps(summary, ensure_ascii=False))
    if dry:
        return
    run_sql(body)
    print("imported")


if __name__ == "__main__":
    main()
