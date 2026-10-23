#!/usr/bin/env python3
"""從舊站 HTML 快照擷取 Blocksy 版面骨架（header、抽屜、footer、浮動按鈕等主題標記），
轉成帶 {{佔位符}} 的模板字串，輸出 src/theme/fragments.generated.ts。
只擷取主題標記（無顧客/訂單資料）。用法：python3 -I scripts/frontend/extract_fragments.py <export_dir>"""
import json, os, re, sys

EXPORT = os.path.abspath(sys.argv[1])
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OLD = 'https://go.palacetwshop.com'

def read(name):
    return open(os.path.join(EXPORT, 'html', name), encoding='utf-8').read()

def strip_scripts(h):
    return re.sub(r'<script\b.*?</script>', '', h, flags=re.S)

def between(h, start, end, include_end=True):
    i = h.index(start)
    j = h.index(end, i + len(start))
    return h[i:j + (len(end) if include_end else 0)]

def balanced_div(h, start_marker):
    """回傳從 start_marker 所在 <div 開始、到對應 </div> 結束的片段"""
    i = h.index(start_marker)
    i = h.rfind('<div', 0, i + 1) if not h[i:].startswith('<div') else i
    depth = 0
    for m in re.finditer(r'<div\b|</div>', h[i:]):
        depth += 1 if m.group(0) == '<div' else -1
        if depth == 0:
            return h[i:i + m.end()]
    raise ValueError(start_marker)

def clean(s):
    s = s.replace(OLD + '/', '/').replace(OLD, '/')
    s = re.sub(r'<input type="hidden" id="blocksy-lostpassword-nonce"[^>]*/?>', '', s)
    s = re.sub(r'<input type="hidden" name="_wp_http_referer"[^>]*/?>', '', s)
    s = re.sub(r'<input type="hidden" value="[0-9a-f]{10}" class="ct-live-results-nonce">', '', s)
    return s

F = {}
idx = strip_scripts(read('index.html'))
prod = strip_scripts(read('product__art11.html'))
cart = strip_scripts(read('cart-2__with-item.html'))
blog = strip_scripts(read('blog-2.html'))
p888 = strip_scripts(read('product__art888.html'))

# --- offcanvas（手機選單抽屜）
off = balanced_div(idx, '<div id="offcanvas"')
off = re.sub(r'<ul id="menu-main-menu-1" role="menubar">.*?</ul>', '{{MOBILE_MENU}}', off, flags=re.S)
off = re.sub(r'(class="site-logo-container"[^>]*>\s*<img[^>]*?src=")[^"]*(")', r'\1{{LOGO}}\2', off, flags=re.S)
off = re.sub(r'\s(srcset|sizes)="[^"]*"', '', off)
F['offcanvas'] = clean(off)

# --- 篩選抽屜外框
fp = balanced_div(idx, '<div id="woo-filters-panel"')
inner = balanced_div(fp, '<div class="ct-panel-content-inner ct-sidebar">')
F['filtersPanel'] = clean(fp.replace(inner, '<div class="ct-panel-content-inner ct-sidebar">{{WIDGETS}}</div>'))

# --- 側邊購物車抽屜
cp = balanced_div(idx, '<div id="woo-cart-panel"')
ci = balanced_div(cp, '<div class="ct-panel-content-inner">')
F['cartPanel'] = clean(cp.replace(ci, '<div class="ct-panel-content-inner">{{MINI_CART}}</div>'))

# --- 帳號彈窗
am = balanced_div(idx, '<div id="account-modal"')
F['accountModal'] = clean(am)

# --- header
hd = between(idx, '<header id="header"', '</header>')
hd = re.sub(r'<ul id="menu-main-menu" class="menu" role="menubar">.*?</ul>', '{{MENU}}', hd, flags=re.S)
cart_item = re.search(r'<a class="ct-cart-item ct-offcanvas-trigger".*?</a>', hd, re.S).group(0)
hd = hd.replace(cart_item, '{{CART_ITEM}}')
hd = hd.replace(' data-transparent=""', '{{T_ATTR}}').replace(' data-transparent-row="yes"', '{{T_ROW}}')
F['header'] = clean(hd)
ci2 = cart_item.replace('data-count="0" aria-hidden="true">0<', 'data-count="{{COUNT}}" aria-hidden="true">{{COUNT}}<')
ci2 = re.sub(r'<span class="ct-amount">.*?</span></span></span>', '<span class="ct-amount">{{AMOUNT}}</span></span>', ci2, flags=re.S)
ci2 = ci2.replace('data-auto-open="archive"', '{{AUTO_OPEN}}')
F['cartTrigger'] = clean(ci2)

# --- 頁尾上方內容區塊包裝與 footer
ft = between(idx, '<footer id="footer"', '</footer>')
ft = ft.replace('https://startersites.io/blocksy/pottery/wp-content/uploads/2024/03/payment-icons.svg', '{{PAYMENT_ICONS}}')
ft = re.sub(r'<p>承城顧問有限公司版權所有</p>', '<p>{{COPYRIGHT}}</p>', ft)
F['footer'] = clean(ft)

# --- 手機底部捷徑列
def shortcuts(h):
    s = balanced_div(h, '<div class="ct-drawer-canvas" data-location="end"')
    s = s.replace('href=""', 'href="/"').replace('href="' + OLD + '"', 'href="/"')
    return clean(s)
F['shortcutsShop'] = shortcuts(idx)
F['shortcutsDefault'] = shortcuts(prod)

# --- 商品列表上方（手機篩選按鈕）與 loading
F['listingTop'] = clean(balanced_div(idx, '<div class="woo-listing-top">'))
F['filtersLoading'] = clean(re.search(r'<span class="ct-filters-loading">.*?</span>', idx, re.S).group(0))
pag = re.search(r'<nav class="ct-pagination".*?</nav>', idx, re.S).group(0)
F['nextArrow'] = re.search(r'<svg width="9px".*?</svg>', pag, re.S).group(0)
F['loadMoreHelper'] = clean(balanced_div(pag, '<div class="ct-load-more-helper">'))
prev_svg = None

# --- 搜尋表單、麵包屑分隔符
F['searchForm'] = clean(re.search(r'<form role="search".*?</form>', blog, re.S).group(0))
F['breadcrumbSep'] = re.search(r'<svg class="ct-separator".*?</svg>', blog, re.S).group(0)

# --- 購物車移除圖示、帳號/關閉圖示
F['removeIcon'] = re.search(r'<svg class="ct-icon" width="10px" height="10px" viewBox="0 0 24 24">.*?</svg>', cart, re.S).group(0)
F['closeIcon'] = re.search(r'<svg class="ct-icon" width="12" height="12" viewBox="0 0 15 15">.*?</svg>', idx, re.S).group(0)

# --- 商品圖庫箭頭
F['flexyPrev'] = re.search(r'<span class="flexy-arrow-prev ct-hidden-sm">.*?</span>', p888, re.S).group(0)
F['flexyNext'] = re.search(r'<span class="flexy-arrow-next ct-hidden-sm">.*?</span>', p888, re.S).group(0)

# --- 浮動 LINE 按鈕（Chaty）
chaty_bg = re.search(r'<svg width="39" height="39" viewBox="0 0 39 39" class="hide-cht-svg-bg".*?</svg>', cart, re.S).group(0)
chaty = balanced_div(cart, '<div style="display: none" class="chaty chaty-id-0')
chaty = chaty.replace('<div style="display: none" class="chaty ', '<div class="chaty ')
chaty = re.sub(r' data-nonce="[0-9a-f]+"', '', chaty)
F['chaty'] = clean(chaty_bg + chaty)

# --- 篩選小工具的圖示
side = balanced_div(idx, '<aside class="ct-hidden-sm ct-hidden-md"') if False else None
F['filterSearchIcons'] = re.search(r'<span class="ct-filter-search-icon">.*?</span>', idx, re.S).group(0)

out = ['// 自動產生：scripts/frontend/extract_fragments.py（來源：舊站 HTML 快照的主題標記）', '/* eslint-disable */', 'export const F = {']
for k, v in F.items():
    out.append(f'  {k}: {json.dumps(v, ensure_ascii=False)},')
out.append('} as const;')
p = os.path.join(REPO, 'src', 'theme', 'fragments.generated.ts')
open(p, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('fragments', {k: len(v) for k, v in F.items()})
