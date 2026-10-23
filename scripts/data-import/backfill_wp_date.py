#!/usr/bin/env python3
"""回填 meta.wp_date = {date, date_gmt}（WordPress local 日期與 GMT）到 site_gopalacetw.posts / products。
前台日期顯示直接用 wp_date.date（WP 的 local `date`），不做時區換算。
用法：source ~/.config/gather-migrate/env && python3 -I backfill_wp_date.py ~/gather-migrate/gopalacetw/export
（只讀 export/rest 的 pages.json、ct_content_block.json、product.json；不含任何個資）"""
import json, os, sys, urllib.request

E = sys.argv[1]
def J(f): return json.load(open(os.path.join(E, 'rest', f)))
def lit(s): return "'" + s.replace("'", "''") + "'"

def sql_for(table, items):
    vals = ",".join(f"({int(p['id'])},{lit(p['date'])},{lit(p['date_gmt'])})" for p in items)
    return (f"update site_gopalacetw.{table} t set meta = coalesce(t.meta,'{{}}'::jsonb) || jsonb_build_object('wp_date', jsonb_build_object('date', v.d, 'date_gmt', v.g)) "
            f"from (values {vals}) as v(id,d,g) where t.id = v.id returning t.id")

def run(q):
    req = urllib.request.Request('https://api.supabase.com/v1/projects/ozwftlkgqmewtadypsfi/database/query',
        data=json.dumps({'query': q}).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN'], 'Content-Type': 'application/json', 'User-Agent': 'GatherMigrator/1.0'})
    return json.load(urllib.request.urlopen(req))

pages = J('pages.json') + J('ct_content_block.json')
print('posts updated:', len(run(sql_for('posts', pages))), '/', len(pages))
prods = J('product.json')
print('products updated:', len(run(sql_for('products', prods))), '/', len(prods))
