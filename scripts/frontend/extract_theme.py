#!/usr/bin/env python3
"""從舊站抽取資料（export/，不在 repo 內）產生前台主題資產：
- public/wp-content/... ：Blocksy / WooCommerce / 外掛 CSS 與字型（GPL 主題程式碼，非站點資料）
- public/legacy-inline/*.css ：全站共用的 inline <style>（Blocksy customizer、WP global styles 等）
- src/theme/head-assets.json ：<head> 中樣式載入順序（依舊站順序合併）
用法：python3 -I scripts/frontend/extract_theme.py <export_dir>
"""
import json, os, re, shutil, sys, glob, hashlib

EXPORT = os.path.abspath(sys.argv[1])
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PUB = os.path.join(REPO, 'public')
OLD = 'https://go.palacetwshop.com'

design = json.load(open(os.path.join(EXPORT, 'design', 'index.json')))
url2local = {}
for s in design['stylesheets']:
    if s.get('local'):
        url2local[s['url'].split('?')[0]] = os.path.join(EXPORT, s['local'])

# 不全站載入的 inline style（改由頁面/內容區塊各自輸出）
SKIP_INLINE = re.compile(r'^(greenshift-post-css|ct-main-styles-inline-css|custom-advance-chaty-css)')

order = []          # 合併後的順序
seen = set()
inline_css = {}

def key_of(tag):
    m = re.search(r"href=['\"]([^'\"]+)['\"]", tag)
    if tag.startswith('<link'):
        href = m.group(1).replace('&#038;', '&').replace('&amp;', '&')
        return ('link', href)
    a = re.match(r'<style([^>]*)>', tag).group(1)
    idm = re.search(r"id=['\"]([^'\"]+)", a)
    body = re.search(r'<style[^>]*>(.*?)</style>', tag, re.S).group(1)
    if idm:
        return ('inline', idm.group(1)), body
    cls = re.search(r"class=['\"]([^'\"]+)", a)
    h = hashlib.md5(body.encode()).hexdigest()[:8]
    return ('inline', (cls.group(1) if cls else 'anon') + '-' + h), body

files = sorted(glob.glob(os.path.join(EXPORT, 'html', '*.html')))
files.sort(key=lambda f: (os.path.basename(f) != 'index.html', f))
# 各版型代表頁（舊站每種版型載入的樣式表不同，例如 Elementor CSS 只在 Elementor 頁面載入）
GROUPS = {
    'shop': 'index.html',
    'product_cat': 'product-category__standard.html',
    'product_tag': 'product-tag__women.html',
    'product': 'product__art888.html',
    'page': 'home-2.html',
    'page_elementor': 'home01.html',
    'page_products': '完售.html',
    'cart': 'cart-2__with-item.html',
    'checkout': 'checkout-2__with-item.html',
    'account': 'my-account-2.html',
    'blog': 'blog-2.html',
    'category': 'category__news.html',
    'search': '__s__test.html',
    'ct_content_block': 'ct_content_block__above-footer-section.html',
}
page_keys = {}
for f in files:
    h = open(f, encoding='utf-8', errors='ignore').read()
    if '<body' not in h:
        continue
    head = h[:h.find('<body')]
    body = h[h.find('<body'):]
    # noscript 內的樣式不載入
    head = re.sub(r'<noscript>.*?</noscript>', '', head, flags=re.S)
    body = re.sub(r'<noscript>.*?</noscript>', '', body, flags=re.S)
    tags = re.findall(r"<link rel=['\"]stylesheet['\"][^>]*>|<style[^>]*>.*?</style>", head + body, re.S)
    prev = None
    keys_here = []
    for t in tags:
        k = key_of(t)
        if isinstance(k, tuple) and len(k) == 2 and isinstance(k[0], tuple):
            k, css = k
            if SKIP_INLINE.match(k[1]):
                continue
            if not css.strip():
                continue
            inline_css.setdefault(k[1], css)
        if k not in seen:
            seen.add(k)
            idx = order.index(prev) + 1 if prev in order else len(order)
            order.insert(idx, k)
        if k not in keys_here:
            keys_here.append(k)
        prev = k
    page_keys[os.path.basename(f)] = keys_here

assets = []
key_href = {}
os.makedirs(os.path.join(PUB, 'legacy-inline'), exist_ok=True)
missing = []
for kind, v in order:
    n_before = len(assets)
    if kind == 'link':
        base = v.split('?')[0]
        if base.startswith(OLD):
            local = url2local.get(base)
            rel = base[len(OLD):]
            dst = os.path.join(PUB, rel.lstrip('/'))
            if not local or not os.path.exists(local):
                if os.path.exists(dst):   # 已另行唯讀抓取放入 public/
                    assets.append({'type': 'link', 'href': rel}); continue
                missing.append(base); continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            css = open(local, encoding='utf-8', errors='ignore').read()
            css = css.replace(OLD, '')
            open(dst, 'w', encoding='utf-8').write(css)
            assets.append({'type': 'link', 'href': rel})
        else:
            assets.append({'type': 'link', 'href': v, 'external': True})
    else:
        css = inline_css.get(v, '')
        css = css.replace(OLD + '/wp-content/plugins/woocommerce/assets/fonts/', '/wp-content/plugins/woocommerce/assets/fonts/')
        css = css.replace(OLD, '')
        name = re.sub(r'[^a-zA-Z0-9_.-]', '-', v) + '.css'
        open(os.path.join(PUB, 'legacy-inline', name), 'w', encoding='utf-8').write(css)
        assets.append({'type': 'link', 'href': '/legacy-inline/' + name, 'inline_id': v})

# key -> href 對照（依 assets 產生順序）
for a in assets:
    key_href[a.get('inline_id') or a['href']] = a['href']
def href_of(k):
    kind, v = k
    if kind == 'inline':
        return key_href.get(v)
    base = v.split('?')[0]
    if base.startswith(OLD):
        return key_href.get(base[len(OLD):])
    return key_href.get(v)
groups = {}
for g, fn in GROUPS.items():
    groups[g] = [h for h in (href_of(k) for k in page_keys.get(fn, [])) if h]
    # Chaty 的顏色 CSS 在舊站由外掛 JS 於每頁注入（快照只在 2 頁擷取到）
    if '/legacy-inline/custom-chaty-css.css' not in groups[g]:
        groups[g].append('/legacy-inline/custom-chaty-css.css')

# 字型（相對路徑引用）
src_fonts = os.path.join(EXPORT, 'design', 'fonts', 'wp-content')
for root, _, fs in os.walk(src_fonts):
    for fn in fs:
        s = os.path.join(root, fn)
        d = os.path.join(PUB, 'wp-content', os.path.relpath(s, src_fonts))
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copyfile(s, d)

os.makedirs(os.path.join(REPO, 'src', 'theme'), exist_ok=True)
json.dump({'assets': assets, 'groups': groups}, open(os.path.join(REPO, 'src', 'theme', 'head-assets.json'), 'w'), ensure_ascii=False, indent=1)
print('assets', len(assets), 'missing', missing)
