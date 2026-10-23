"""從舊站分類頁快照（export/html/product-category__*.html）取出 rearrange-woocommerce-products
的分類專屬商品順序，產生寫入 site_gopalacetw.terms.meta.product_order 的 SQL。
用法：python3 scripts/frontend/term_order.py <export_dir> > /tmp/x.sql"""
import json, os, re, sys, urllib.parse

exp = sys.argv[1]
d = os.path.join(exp, "html")
orders = {}
for f in sorted(os.listdir(d)):
    m = re.match(r"product-category__(.+?)(?:__page__(\d+))?\.html$", f)
    if not m:
        continue
    slug, page = m.group(1), int(m.group(2) or 1)
    ids = [int(x) for x in re.findall(r'<li[^>]*class="[^"]*\bproduct\b[^"]*post-(\d+)', open(os.path.join(d, f)).read())]
    orders.setdefault(slug, {})[page] = ids
for slug, pages in orders.items():
    seq = [i for p in sorted(pages) for i in pages[p]]
    if not seq:
        continue
    enc = urllib.parse.quote(slug).lower()
    print(
        "update site_gopalacetw.terms set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{product_order}', '%s'::jsonb) "
        "where taxonomy = 'product_cat' and (slug = '%s' or slug = '%s');" % (json.dumps(seq), slug.replace("'", "''"), enc)
    )
