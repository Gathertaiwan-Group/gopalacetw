#!/usr/bin/env python3
"""把 WordPress 原始 post_title / post_excerpt / post_content 存進 site_gopalacetw.{posts,products}.search_raw，
讓前台 /?s= 與 WordPress 一樣只比對原始字串（不比對渲染後的區塊／短代碼輸出）。

用法（資料目錄在 repo 之外）：
  source ~/.config/gather-migrate/env
  python3 -I scripts/data-import/import_search_raw.py ~/gather-migrate/_db/gopalacetw/tables
只處理已存在於新站的頁面／文章／商品；只輸出筆數。
"""
import json
import os
import sys
import urllib.request

SCHEMA = "site_gopalacetw"
PROJECT = "ozwftlkgqmewtadypsfi"


def sql(q):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"], "Content-Type": "application/json", "User-Agent": "GatherMigrator/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"[]")


def lit(s):
    tag = "$sr$"
    assert tag not in s
    return tag + s + tag


def main():
    src = sys.argv[1]
    rows = {}
    with open(os.path.join(src, "wp_posts.jsonl"), encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r.get("post_type") in ("post", "page", "product"):
                rows[int(r["ID"])] = r
    for table, types in (("posts", ("post", "page")), ("products", ("product",))):
        ids = {x["id"] for x in sql(f"select id from {SCHEMA}.{table}")}
        vals = []
        for i, r in rows.items():
            if i in ids and r["post_type"] in types:
                # WordPress 搜尋：post_title LIKE OR post_excerpt LIKE OR post_content LIKE（每個詞）
                vals.append(f"({i}, {lit(r['post_title'] + chr(10) + r['post_excerpt'] + chr(10) + r['post_content'])})")
        if vals:
            res = sql(f"update {SCHEMA}.{table} t set search_raw = v.raw from (values {', '.join(vals)}) as v(id, raw) where t.id = v.id returning t.id")
            print(table, "search_raw 更新", len(res), "筆")


if __name__ == "__main__":
    main()
