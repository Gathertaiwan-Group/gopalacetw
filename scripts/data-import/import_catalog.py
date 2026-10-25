#!/usr/bin/env python3
"""依 WordPress 資料庫校正商品目錄資料（取代 build.py 由公開 HTML 推測的值）。

- products.featured / catalog_visibility：由 term_relationships 的 product_visibility 詞彙對應
  （WooCommerce 規則：exclude-from-catalog + exclude-from-search → hidden；只有 catalog → search；
   只有 search → catalog；都沒有 → visible；featured 詞彙 → featured=true）
- products.name：存 WordPress 原始 post_title（前台輸出時再 wptexturize，見 src/theme/util.ts）
- 屬性詞彙 pa_*（wp_term_taxonomy）→ terms
- 草稿頁面／草稿商品（post_status=draft）→ posts / products（status=draft；RLS 已擋 anon 讀非 publish）

用法（資料目錄在 repo 之外，含個資；本腳本只讀 wp_posts / wp_postmeta / wp_terms / wp_term_taxonomy /
wp_term_relationships / wp_termmeta，不讀顧客或訂單；只輸出筆數）：
  source ~/.config/gather-migrate/env
  python3 -I scripts/data-import/import_catalog.py ~/gather-migrate/_db/gopalacetw/tables [--dry-run]

冪等：以 WordPress 原始 ID 為主鍵 upsert。
"""
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_private import SCHEMA, gmt, jlit, load, php_unserialize, run_sql, upsert  # noqa: E402


def visibility(slugs):
    cat, search = "exclude-from-catalog" in slugs, "exclude-from-search" in slugs
    if cat and search:
        return "hidden"
    if cat:
        return "search"
    if search:
        return "catalog"
    return "visible"


def main():
    src = os.path.expanduser(sys.argv[1])
    dry = "--dry-run" in sys.argv
    L = lambda n: load(src, n)

    posts = {p["ID"]: p for p in L("wp_posts")}
    pm = defaultdict(dict)
    for m in L("wp_postmeta"):
        pm[m["post_id"]][m["meta_key"]] = m["meta_value"]
    terms = {t["term_id"]: t for t in L("wp_terms")}
    tt = {t["term_taxonomy_id"]: t for t in L("wp_term_taxonomy")}
    tmeta = defaultdict(dict)
    for m in L("wp_termmeta"):
        tmeta[m["term_id"]][m["meta_key"]] = m["meta_value"]
    vis_terms = defaultdict(set)  # object_id -> product_visibility slugs
    obj_terms = defaultdict(list)  # object_id -> [(taxonomy, term_id)]
    for r in L("wp_term_relationships"):
        t = tt.get(r["term_taxonomy_id"])
        if not t:
            continue
        obj_terms[r["object_id"]].append((t["taxonomy"], t["term_id"]))
        if t["taxonomy"] == "product_visibility":
            vis_terms[r["object_id"]].add(terms[t["term_id"]]["slug"])

    existing = run_sql(
        f"select (select coalesce(json_agg(id),'[]') from {SCHEMA}.products) p,"
        f" (select coalesce(json_agg(id),'[]') from {SCHEMA}.posts) po,"
        f" (select coalesce(json_agg(id),'[]') from {SCHEMA}.terms) t"
    )[0]
    product_ids, post_ids, term_ids = set(existing["p"]), set(existing["po"]), set(existing["t"])

    sql = ["begin;"]
    summary = {}

    # ---------- 1/2. featured + catalog_visibility（所有 WP 商品，含草稿）
    wp_products = [p for p in posts.values() if p["post_type"] == "product" and p["post_status"] not in ("auto-draft", "trash", "inherit")]
    vis_rows = []
    for p in wp_products:
        slugs = vis_terms.get(p["ID"], set())
        vis_rows.append({"id": p["ID"], "featured": "featured" in slugs, "catalog_visibility": visibility(slugs)})
    summary["visibility"] = {v: sum(1 for r in vis_rows if r["catalog_visibility"] == v) for v in ("visible", "catalog", "search", "hidden")}
    summary["featured"] = [r["id"] for r in vis_rows if r["featured"]]

    # ---------- 4. 草稿頁面／商品（新站尚無的才新增；已存在者不覆寫內容）
    draft_pages, draft_products = [], []
    for p in posts.values():
        if p["post_status"] != "draft" or p["ID"] in post_ids or p["ID"] in product_ids:
            continue
        meta = pm.get(p["ID"], {})
        wp_date = {"date": p["post_date"].replace(" ", "T"), "date_gmt": None if p["post_date_gmt"].startswith("0000") else p["post_date_gmt"].replace(" ", "T")}
        if p["post_type"] == "page":
            draft_pages.append({
                "id": p["ID"], "post_type": "page", "slug": p["post_name"] or str(p["ID"]), "status": "draft",
                "title": p["post_title"], "content": p["post_content"], "excerpt": p["post_excerpt"],
                "author_id": p["post_author"], "parent_id": p["post_parent"] or None, "menu_order": p["menu_order"],
                "template": "" if meta.get("_wp_page_template") in (None, "default") else meta["_wp_page_template"],
                "comment_status": p["comment_status"], "ping_status": p["ping_status"], "password": p["post_password"] or None,
                "path": None, "meta": {"wp_meta": {k: v for k, v in meta.items() if not k.startswith("_edit_")}, "wp_date": wp_date, "source": "wp_db draft"},
                "seo": {}, "published_at": gmt(p["post_date_gmt"]), "modified_at": gmt(p["post_modified_gmt"]),
                "search_raw": p["post_title"] + "\n" + p["post_excerpt"] + "\n" + p["post_content"],
            })
        elif p["post_type"] == "product":
            price = meta.get("_price")
            draft_products.append({
                "id": p["ID"], "slug": p["post_name"], "name": p["post_title"], "type": "simple", "status": "draft",
                "featured": "featured" in vis_terms.get(p["ID"], set()), "catalog_visibility": visibility(vis_terms.get(p["ID"], set())),
                "sku": meta.get("_sku") or None, "description": p["post_content"], "short_description": p["post_excerpt"],
                "regular_price": float(meta["_regular_price"]) if meta.get("_regular_price") else None,
                "sale_price": float(meta["_sale_price"]) if meta.get("_sale_price") else None,
                "price": float(price) if price else None,
                "manage_stock": meta.get("_manage_stock") == "yes", "stock_status": meta.get("_stock_status") or "instock",
                "menu_order": p["menu_order"], "reviews_allowed": p["comment_status"] == "open", "path": None,
                "meta": {"wp_meta": {k: v for k, v in meta.items() if not k.startswith("_edit_")}, "wp_date": wp_date, "source": "wp_db draft"},
                "seo": {}, "published_at": gmt(p["post_date_gmt"]), "modified_at": gmt(p["post_modified_gmt"]),
                "search_raw": p["post_title"] + "\n" + p["post_excerpt"] + "\n" + p["post_content"],
            })
    summary["draft_pages"] = [r["id"] for r in draft_pages]
    summary["draft_products"] = [r["id"] for r in draft_products]
    sql.append(upsert("posts", draft_pages))
    sql.append(upsert("products", draft_products))
    draft_terms = [{"product_id": r["id"], "term_id": tid, "term_order": i}
                   for r in draft_products for i, (tax, tid) in enumerate(obj_terms.get(r["id"], [])) if tax in ("product_cat", "product_tag")]
    if draft_terms:
        sql.append(upsert("product_terms", draft_terms, conflict="product_id, term_id"))

    # 草稿匯入後再套可見度（草稿商品已含在 vis_rows）
    known = product_ids | {r["id"] for r in draft_products}
    vis_rows = [r for r in vis_rows if r["id"] in known]
    sql.append(
        f"update {SCHEMA}.products t set featured = v.featured, catalog_visibility = v.catalog_visibility"
        f" from jsonb_to_recordset({jlit(vis_rows)}) as v(id bigint, featured boolean, catalog_visibility text)"
        f" where t.id = v.id and (t.featured is distinct from v.featured or t.catalog_visibility is distinct from v.catalog_visibility);"
    )

    # ---------- 5. 商品名稱改存 WP 原始 post_title（前台再 wptexturize）
    # clear_search_raw trigger 會在名稱變更時清空 search_raw → 第二段 update 以 WP 原始字串補回
    name_rows = [{"id": p["ID"], "name": p["post_title"], "raw": p["post_title"] + "\n" + p["post_excerpt"] + "\n" + p["post_content"]}
                 for p in wp_products if p["ID"] in product_ids]
    sql.append(
        f"create temp table _names on commit drop as select * from jsonb_to_recordset({jlit(name_rows)}) as v(id bigint, name text, raw text);"
        f"\ncreate temp table _renamed on commit drop as select t.id from {SCHEMA}.products t join _names v on v.id = t.id where t.name is distinct from v.name;"
        f"\nupdate {SCHEMA}.products t set name = v.name from _names v where t.id = v.id and t.id in (select id from _renamed);"
        f"\nupdate {SCHEMA}.products t set search_raw = v.raw from _names v where t.id = v.id and t.id in (select id from _renamed);"
    )

    # ---------- 3. 屬性詞彙 pa_*
    attr_terms = []
    for t in tt.values():
        if not t["taxonomy"].startswith("pa_"):
            continue
        tm = tmeta.get(t["term_id"], {})
        opts = tm.get("blocksy_taxonomy_meta_options")
        try:
            opts = php_unserialize(opts) if opts else None
        except Exception:
            opts = None
        color = (((opts or {}).get("accent_color") or {}).get("default") or {}).get("color") if isinstance(opts, dict) else None
        attr_terms.append({
            "id": t["term_id"], "taxonomy": t["taxonomy"], "slug": terms[t["term_id"]]["slug"], "name": terms[t["term_id"]]["name"],
            "description": t["description"] or "", "parent_id": t["parent"] or None, "count": t["count"],
            "menu_order": int(tm.get("order") or 0),
            "meta": {"wp_term_taxonomy_id": t["term_taxonomy_id"], **({"color": color} if color else {}), "wp_termmeta": {k: v for k, v in tm.items() if k != "blocksy_taxonomy_meta_options"}},
            "seo": {},
        })
    clash = [r["id"] for r in attr_terms if r["id"] in term_ids]
    summary["attribute_terms"] = {tax: sum(1 for r in attr_terms if r["taxonomy"] == tax) for tax in sorted({r["taxonomy"] for r in attr_terms})}
    summary["attribute_terms_existing_ids"] = clash
    sql.append(upsert("terms", attr_terms))

    sql.append("commit;")
    print(json.dumps(summary, ensure_ascii=False))
    if dry:
        return
    run_sql("\n".join(x for x in sql if x))
    print("imported")


if __name__ == "__main__":
    main()
