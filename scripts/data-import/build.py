import json,re,os,sys,html,urllib.parse as up,collections,hashlib
E=os.path.expanduser('~/gather-migrate/gopalacetw/export'); S=os.path.dirname(os.path.abspath(__file__))
J=lambda p: json.load(open(E+'/'+p))
up_res=json.load(open(S+'/media_uploaded.json'))
OLD='go.palacetwshop.com'
# ---- media lookup: rel path -> upload result
path2up={}
for u in up_res:
    for p in u['paths']: path2up[p]=u
lib=J('rest/media.json')
THUMB=re.compile(r'-\d+x\d+(?=\.[A-Za-z0-9]+$)')
def orig_rel(rel):
    rel=THUMB.sub('',rel); rel=re.sub(r'-scaled(\.[A-Za-z0-9]+)$',r'\1',rel); return rel
FALLBACK={'2021/04/woocommerce-placeholder.png':'2019/04/woocommerce-placeholder.png'}
def media_new(rel):
    o=orig_rel(rel); o=FALLBACK.get(o,o)
    u=path2up.get(o)
    return u['public_url'] if u else None
# ---- page_id / p lookups
pages=J('rest/pages.json'); prods=J('rest/product.json')
id2path={p['id']:'/'+p['slug']+'/' for p in pages}
for p in prods: id2path[p['id']]='/product/'+p['slug']+'/'
front=J('rest/root.json')['page_on_front']; id2path[front]='/'
unresolved=collections.Counter()
URLRE=re.compile(r'(?:https?:)?(?:\\?/){2}(?:www\.)?(go\.palacetwshop\.com|startersites\.io/blocksy/pottery)((?:\\?/)[^\s"\'()<>,]*)?')
def dec(s):
    s=s.replace('\\/','/')
    s=re.sub(r'\\u([0-9a-fA-F]{4})',lambda m:chr(int(m.group(1),16)),s)
    s=html.unescape(s)
    return up.unquote(s)
def rw(text):
    if not text: return text
    def sub(m):
        whole=m.group(0); host=m.group(1); path=m.group(2) or '/'
        tail=''
        # 切掉被吃進來的 HTML 實體結尾 / 反斜線
        mm=re.search(r'(&quot;|&#0?39;|&#8221;|&#8217;|\\+)$',path)
        if mm: tail=path[mm.start():]; path=path[:mm.start()]
        esc='\\/' in whole
        p=dec(path)
        p_noq=p.split('?')[0].split('#')[0]
        if '/wp-content/uploads/' in p_noq:
            rel=p_noq.split('/wp-content/uploads/',1)[1]
            n=media_new(rel)
            if not n and (rel=='' or rel.endswith('/')):
                n=os.environ['SUPABASE_URL']+'/storage/v1/object/public/site-gopalacetw/uploads/'+rel
            if not n: unresolved['media:'+p_noq]+=1; return whole
            out=n
        elif host!=OLD:
            unresolved['external:'+host+p]+=1; return whole
        elif p_noq.startswith('/wp-content/') or p_noq.startswith('/wp-json') or p_noq.startswith('/wp-admin') or p_noq.startswith('/wp-includes'):
            unresolved['asset:'+p_noq]+=1; return whole
        else:
            q=up.urlparse(p)
            qs=up.parse_qs(q.query)
            if q.path in ('','/') and ('page_id' in qs or 'p' in qs):
                pid=int((qs.get('page_id') or qs.get('p'))[0]); out=id2path.get(pid) or '/'
                if pid not in id2path: unresolved['pid:'+p]+=1
            else:
                out=path.replace('\\/','/')  # 保留原 percent-encoding 與 query
                out=html.unescape(out) if '&#038;' in out or '&amp;' in out else out
                if not out.startswith('/'): out='/'+out
                if '&' in out and '&amp;' not in out and not esc: out=out.replace('&','&amp;')
        if esc: out=out.replace('/','\\/')
        return out+tail
    return URLRE.sub(sub,text)
# ---- SEO from html snapshots
hidx={h['url']:h for h in J('html/index.json')}
def seo_for(url):
    h=hidx.get(url)
    if not h: return {}
    s=open(E+'/html/'+h['file'],encoding='utf-8',errors='replace').read()
    head=s[:s.find('</head>')] if '</head>' in s else s[:200000]
    r={}
    m=re.search(r'<title>(.*?)</title>',head,re.S); 
    if m: r['title']=html.unescape(m.group(1).strip())
    for nm,key in [('description','description'),('robots','robots')]:
        m=re.search(r'<meta name="%s" content="([^"]*)"'%nm,head)
        if m: r[key]=html.unescape(m.group(1))
    for prop in ['og:title','og:description','og:type','og:image']:
        m=re.search(r'<meta property="%s" content="([^"]*)"'%prop,head)
        if m: r[prop.replace(':','_')]=rw(html.unescape(m.group(1)))
    m=re.search(r'<link rel="canonical" href="([^"]*)"',head)
    if m: r['canonical_path']=rw(m.group(1))
    m=re.search(r'<script type="application/ld\+json" class="rank-math-schema[^"]*">(.*?)</script>',head,re.S)
    if m:
        try:
            sch=json.loads(rw(m.group(1)))
            if isinstance(sch,dict) and isinstance(sch.get('@graph'),list):
                sch['@graph']=[g for g in sch['@graph'] if g.get('@type')!='Person']  # 去除作者個資（email/頭像）
                for g in sch['@graph']: g.pop('author',None)
            r['schema']=sch
        except Exception: pass
    return r
T=lambda x: html.unescape(x) if isinstance(x,str) else x
rows=collections.OrderedDict()
# ---- authors
rows['authors']=[{'id':i,'slug':f'wp-user-{i}','display_name':None,'meta':{'source':'referenced_by_pages','note':'/wp/v2/users 404；姓名/email 待 DB 匯入'}} for i in sorted({p['author'] for p in pages})]
# ---- media
mrows=[];canon_of={}
for it in sorted(lib,key=lambda x:x['id']):
    rel=orig_rel(it['source_url'].split('/wp-content/uploads/')[1]); u=path2up[rel]
    key=u['sha1']
    mrows.append({'id':it['id'],'wp_id':it['id'],'slug':it['slug'],'title':T(it['title']['rendered']),'alt_text':it['alt_text'],
      'caption':rw(it['caption']['rendered']),'description':rw(it['description']['rendered']),'mime_type':u['mime'],
      'original_path':rel,'old_url':it['source_url'],'storage_path':u['key'],'public_url':u['public_url'],
      'width':u['width'],'height':u['height'],'bytes':u['bytes'],'original_bytes':u['original_bytes'],'sha1':u['sha1'],
      'parent_post_id':it['post'] or None,'author_id':it['author'],'status':'publish','source':'media_library',
      'attachment_url':it['link'].replace('https://'+OLD,'') ,'created_at':it['date_gmt']+'Z','updated_at':it['modified_gmt']+'Z'})
# canonical: 同 sha1 中 original_path == 實際上傳那個 canonical 路徑、id 最小者
grp=collections.defaultdict(list)
for r in mrows: grp[r['sha1']].append(r)
for h,rs in grp.items():
    cp=path2up[rs[0]['original_path']]['canonical']
    c=min([r for r in rs if r['original_path']==cp] or rs,key=lambda r:r['id'])
    for r in rs: r['canonical_media_id']=None if r is c else c['id']
for hid in [1157,1995]:
    mrows.append({'id':hid,'wp_id':hid,'original_path':f'pending/{hid}','old_url':'','status':'private','source':'pending_db','title':None})
rows['media']=mrows
# media_url_map
mm={}
def addmap(old,variant,mid=None):
    rel=None
    d=dec(old)
    if '/wp-content/uploads/' in d: rel=d.split('/wp-content/uploads/',1)[1].split('?')[0]
    if not rel: return
    n=media_new(rel)
    if not n: unresolved['map:'+old]+=1; return
    o=orig_rel(rel); o=FALLBACK.get(o,o)
    if mid is None:
        cands=[r for r in mrows if r.get('original_path')==o]; mid=min(r['id'] for r in cands) if cands else None
    if variant=='auto':
        variant='original' if rel==o else ('scaled' if '-scaled.' in rel else ('missing_fallback' if rel in FALLBACK else 'thumbnail'))
    mm.setdefault(old,{'old_url':old,'new_url':n,'media_id':mid,'variant':variant})
for it in lib: addmap(it['source_url'],'auto',it['id'])
for f in J('media/index.json')['files']:
    v='escaped' if f['status']=='dup_escaped' else 'auto'
    addmap(f['url'],v)
    if f['url'].startswith('http://'): addmap('https://'+f['url'][7:],v)
for x in J('media/external/index.json'): 
    rel=x['local_same_name'].split('media/uploads/')[1]
    mm.setdefault(x['url'],{'old_url':x['url'],'new_url':media_new(rel),'media_id':None,'variant':'external'})
rows['media_url_map']=list(mm.values())
# ---- terms
trows=[]
def seo_url(link): return seo_for(link)
for f,tax in [('tax_categories.json','category'),('tax_tags.json','post_tag'),('tax_product_cat.json','product_cat'),('tax_product_tag.json','product_tag')]:
    for t in J('rest/'+f):
        trows.append({'id':t['id'],'taxonomy':tax,'slug':t['slug'],'name':T(t['name']),'description':rw(t['description']),
          'parent_id':t.get('parent') or None,'count':t['count'],'meta':{'path':up.urlparse(t['link']).path,'wp_meta':t.get('meta') or {}},'seo':seo_for(t['link'])})
sc={c['id']:c for c in J('rest/store_categories.json')}
for r in trows:
    if r['taxonomy']=='product_cat' and r['id'] in sc and sc[r['id']].get('image'): r['image_media_id']=sc[r['id']]['image']['id']
rows['terms']=sorted(trows,key=lambda r:(r.get('parent_id') is not None,r['id']))
rows['attributes']=[{'id':a['id'],'name':a['name'],'slug':a['taxonomy'][3:],'taxonomy':a['taxonomy'],'type':a['type'],'order_by':a['order'],'has_archives':a['has_archives']} for a in J('rest/store_attributes.json')]
# ---- posts
prows=[]
for p in pages:
    path='/' if p['id']==front else '/'+up.unquote(p['slug'])+'/'
    prows.append({'id':p['id'],'post_type':'page','slug':p['slug'],'status':p['status'],'title':T(p['title']['rendered']),
      'content':rw(p['content']['rendered']),'excerpt':rw(p['excerpt']['rendered']),'author_id':p['author'],'parent_id':p['parent'] or None,
      'menu_order':p['menu_order'],'featured_media_id':p['featured_media'] or None,'template':p['template'],'comment_status':p['comment_status'],
      'ping_status':p['ping_status'],'path':path,'custom_css':rw(p['meta'].get('_gspb_post_css') or '') or None,
      'meta':{'wp_meta':{k:v for k,v in p['meta'].items() if k!='_gspb_post_css'},'blocksy_meta':p.get('blocksy_meta'),'class_list':p.get('class_list'),'old_link':p['link'],'wp_date':{'date':p['date'],'date_gmt':p['date_gmt']}},
      'seo':seo_for(p['link']) or seo_for('https://'+OLD+'/' if p['id']==front else p['link']),
      'published_at':p['date_gmt']+'Z','modified_at':p['modified_gmt']+'Z'})
for p in J('rest/ct_content_block.json'):
    prows.append({'id':p['id'],'post_type':'ct_content_block','slug':p['slug'],'status':p['status'],'title':T(p['title']['rendered']),
      'content':rw(p['content']['rendered']),'template':p['template'],'path':'/ct_content_block/'+p['slug']+'/',
      'custom_css':rw(p['meta'].get('_gspb_post_css') or '') or None,'meta':{'wp_meta':{k:v for k,v in p['meta'].items() if k!='_gspb_post_css'},'class_list':p.get('class_list'),'old_link':p['link']},
      'seo':seo_for(p['link']),'published_at':p['date_gmt']+'Z','modified_at':p['modified_gmt']+'Z'})
for p in J('rest/navigation.json'):
    prows.append({'id':p['id'],'post_type':'wp_navigation','slug':p['slug'],'status':p['status'],'title':T(p['title']['rendered']),
      'content':rw(p['content']['rendered']),'template':p['template'],'meta':{'old_link':p['link']},'published_at':p['date_gmt']+'Z','modified_at':p['modified_gmt']+'Z'})
for p in J('rest/posts.json'): raise SystemExit('posts not expected')
rows['posts']=sorted(prows,key=lambda r:(r.get('parent_id') is not None,r['id']))
rows['post_terms']=[]
# ---- products
sp={p['id']:p for p in J('rest/store_products.json')}
order=[]
for f in ['index.html','page__2.html','page__3.html']:
    order+= [int(x) for x in re.findall(r'<li[^>]*class="[^"]*\bproduct\b[^"]*\bpost-(\d+)\b',open(E+'/html/'+f).read())]
media_ids={r['id'] for r in mrows}
def num(x): 
    return None if x in (None,'') else float(x)
pr=[];pimg=[];pterm=[];missing_img=[]
for p in prods:
    s=sp[p['id']]; pc=s['prices']; mx=s['add_to_cart']['maximum']
    managed = mx!=9999 or s['low_stock_remaining']==0
    qty = (mx if mx!=9999 else 0) if managed else None
    if not s['is_in_stock'] and managed: qty=0
    hidden = p['id'] not in order
    noprice = pc['price'] in ('0','') and not s['is_purchasable']
    pr.append({'id':p['id'],'slug':p['slug'],'name':T(s['name']),'type':s['type'],'status':p['status'],
      'catalog_visibility':'hidden' if hidden else 'visible','sku':s['sku'] or None,
      'description':rw(p['content']['rendered']),'short_description':rw(s['short_description']),
      'regular_price':None if noprice else num(pc['regular_price']),'sale_price':num(pc['sale_price']) if s['on_sale'] else None,
      'price':None if noprice else num(pc['price']),'on_sale':s['on_sale'],
      'manage_stock':managed,'stock_quantity':qty,'stock_status':'instock' if s['is_in_stock'] else ('onbackorder' if s['is_on_backorder'] else 'outofstock'),
      'sold_individually':s['sold_individually'],'purchase_min':s['add_to_cart']['minimum'],
      'menu_order':order.index(p['id']) if not hidden else 999,
      'featured_media_id':p['featured_media'] if p['featured_media'] in media_ids else None,
      'average_rating':float(s['average_rating']),'review_count':s['review_count'],
      'reviews_allowed':'comment_status' not in p or p.get('comment_status')=='open',
      'path':'/product/'+up.unquote(p['slug'])+'/',
      'meta':{'class_list':p['class_list'],'old_link':p['link'],'wp_date':{'date':p['date'],'date_gmt':p['date_gmt']},'store_prices_raw':pc,'add_to_cart':s['add_to_cart'],
              'inferred':{'stock':'manage_stock/stock_quantity 由 Store API add_to_cart.maximum（≠9999）與 low_stock_remaining 推得，待 DB 校正',
                          'menu_order':'由首頁（商店頁）三頁商品順序推得（rearrange-woocommerce-products）' if not hidden else '不在商店列表，排序未知，暫置 999',
                          **({'catalog_visibility':'商店/分類列表皆不出現但單頁 200，暫定 hidden；featured／catalog_visibility 以 import_catalog.py 依 DB product_visibility 詞彙校正'} if hidden else {}),
                          **({'price':'Store API 價格為 0 且不可購買，視為未設定價格'} if noprice else {})},
              'wp_meta':p.get('meta') or {}},
      'seo':seo_for(p['link']),'published_at':p['date_gmt']+'Z','modified_at':p['modified_gmt']+'Z'})
    for i,im in enumerate(s['images']):
        if any(x['product_id']==p['id'] and x['media_id']==im['id'] for x in pimg): continue  # 商品圖庫重複圖只留第一次
        if im['id'] in media_ids: pimg.append({'product_id':p['id'],'media_id':im['id'],'position':i})
        else: missing_img.append((p['id'],im['id']))
    for i,c in enumerate(p['product_cat']): pterm.append({'product_id':p['id'],'term_id':c,'term_order':i})
    for i,c in enumerate(p['product_tag']): pterm.append({'product_id':p['id'],'term_id':c,'term_order':100+i})
rows['products']=pr; rows['product_images']=pimg; rows['product_terms']=pterm
# ---- discount rules
rows['discount_rules']=[{'id':d['id'],'slug':d['slug'],'title':T(d['title']['rendered']),'status':d['status'],
   'path':'/ywdpd_discount/'+d['slug']+'/','details_status':'pending_db','published_at':d['date_gmt']+'Z','modified_at':d['modified_gmt']+'Z',
   'raw_meta':{'note':'公開 REST 只有標題；條件/門檻/贈品/加價購價待資料庫匯入'}} for d in J('rest/ywdpd_discount.json')]
# ---- menus
nav=J('rest/navigation.json')[0]
rows['menus']=[
 {'id':1000001,'slug':'main-menu','name':'Main Menu','location':'header','source':'html_snapshot','meta':{'also_location':['mobile-menu'],'wp_menu_ul_id':'menu-main-menu'}},
 {'id':1000002,'slug':'header-contacts','name':'Header Contacts','location':'header_contacts','source':'html_snapshot','meta':{'blocksy_element':'ct-contact-info'}},
 {'id':1000003,'slug':'floating-chaty','name':'Chaty 浮動按鈕','location':'floating','source':'features.json','meta':{'cta_text':'聯絡小編','color':'#A886CD','position':'right'}},
 {'id':nav['id'],'slug':'wp-navigation-'+nav['slug'],'name':T(nav['title']['rendered']),'location':None,'source':'wp_navigation','meta':{'note':'區塊導覽（範本殘留，前台未使用）'}}]
s0=open(E+'/html/index.html').read()
mi=[]
for pos,(iid,href,title) in enumerate(re.findall(r'<li id="menu-item-(\d+)" class="[^"]*"[^>]*><a href="([^"]*)"[^>]*>(.*?)</a>',s0.split('<ul id="menu-main-menu" class="menu"')[1].split('</ul>')[0])):
    slug=up.urlparse(href).path.rstrip('/').split('/')[-1]
    tid=next(t['id'] for t in trows if t['taxonomy']=='product_cat' and t['slug']==slug)
    mi.append({'id':int(iid),'menu_id':1000001,'position':pos,'title':T(title),'url':rw(href),'object_type':'product_cat','object_id':tid})
mi.append({'id':1000101,'menu_id':1000002,'position':0,'title':'Facebook','url':'https://www.facebook.com/p/%E5%8F%B0%E7%81%A3%E5%AE%AE%E5%BB%B7%E9%85%92%E5%BB%A0-100063576617595/','object_type':'custom','target':'_blank','rel':'noopener noreferrer nofollow','aria_label':'最新消息 台灣宮廷官方 Facebook','meta':{'icon':'facebook'}})
mi.append({'id':1000102,'menu_id':1000003,'position':0,'title':'Line','url':'https://line.me/R/ti/p/@uoe1821p','object_type':'custom','target':'_blank','meta':{'channel':'Line'}})
mi.append({'id':1000103,'menu_id':nav['id'],'position':0,'title':'Blog','url':'/blog-2/','object_type':'page','object_id':20})
rows['menu_items']=mi
# ---- forms
feat=J('features.json'); cf=J('screens/checkout_fields__desktop.json')
fdefs=[('header-login','頁首登入（帳號彈窗）','login',0),('lost-password','忘記密碼','lost_password',1),('search','站內搜尋','search',2),('my-account-login','我的帳號登入','login',3),('add-to-cart','加入購物車','add_to_cart',4)]
forms=[]
for slug,name,kind,i in fdefs:
    f=feat['forms'][i]
    forms.append({'slug':slug,'name':name,'kind':kind,'fields':[{'name':x.split(':')[0],'type':x.split(':')[1]} for x in f['fields']],
      'settings':{'method':f.get('method'),'action':rw(f.get('action') or '') or None,'class':f.get('class'),'page_count':f.get('page_count')},'source':'features.json'})
forms.append({'slug':'checkout','name':'結帳','kind':'checkout','fields':[x for x in cf if not x['name'].startswith('wc_order_attribution_')],
   'settings':{'payment_methods':feat['cart_checkout']['payment_methods'],'shipping_methods':feat['cart_checkout']['shipping_methods'],
               'coupon_field_on_checkout':feat['cart_checkout']['coupon_field_on_checkout'],'attribution_fields':[x['name'] for x in cf if x['name'].startswith('wc_order_attribution_')],
               'real_payment':False},'source':'screens/checkout_fields__desktop.json'})
rows['forms']=forms
# ---- redirects
red=[{'source_path':'/cart/','target':'/cart-2/','kind':'legacy','note':'舊站 /cart/ 導向 /cart-2/'},
 {'source_path':'/checkout/','target':'/checkout-2/','kind':'legacy','note':'舊站 /checkout/ 導向 -2 版本'},
 {'source_path':'/my-account/','target':'/my-account-2/','kind':'legacy','note':'舊站 /my-account/ 導向 /my-account-2/'},
 {'source_path':'/shop/','target':'/','kind':'legacy','note':'首頁即商店頁'},
 {'source_path':'/shop-2/','target':'/','kind':'legacy','note':'page_on_front=1035 (shop-2)'},
 {'source_path':'/product/翠玉白菜/','target':'/product/翠玉白菜燈/','kind':'slug_change','note':'sitemap 舊 slug → 現行商品'},
 {'source_path':'/?page_id=20','target':'/blog-2/','kind':'legacy','note':'wp_navigation 連結'}]
seen={r['source_path'] for r in red}
for r in mrows:
    if r.get('attachment_url') and r['status']=='publish':
        sp_=up.unquote(r['attachment_url'])
        if sp_ in seen: continue
        seen.add(sp_); red.append({'source_path':sp_,'target':r['public_url'],'kind':'attachment','note':f"附件頁 → 檔案（attachment {r['id']}）"})
rows['redirects']=red
# ---- settings
root=J('rest/root.json'); icon=next(r for r in mrows if r['id']==root['site_icon'])
st=[('site',{'name':root['name'],'description':root['description'],'old_url':root['url'],'language':'zh-TW','timezone':'Asia/Taipei','gmt_offset':8},'rest/root.json'),
 ('reading',{'show_on_front':root['show_on_front'],'page_on_front':root['page_on_front'],'page_for_posts':root['page_for_posts'],'products_per_page':16,'shop_pagination':'infinite_scroll','default_product_orderby':'menu_order'},'rest/root.json + html'),
 ('site_icon',{'media_id':root['site_icon'],'url':icon['public_url']},'rest/root.json'),
 ('site_logo',{'media_id':root['site_logo'] or None},'rest/root.json'),
 ('currency',{'code':'TWD','symbol':'NT$','position':'left','decimals':0,'thousand_sep':',','decimal_sep':'.'},'rest/store_products.json prices'),
 ('pages',{'cart':'/cart-2/','checkout':'/checkout-2/','my_account':'/my-account-2/','shop':'/','blog':'/blog-2/','cart_page_id':1036,'checkout_page_id':1037,'myaccount_page_id':10,'shop_page_id':1035},'features.json'),
 ('shipping',{'methods':[{'id':'flat_rate:1','title':'宅配到家(滿6000免運）','cost':150}],'free_shipping_min_amount':6000,'shipping_progress_bar':True,'note':'由結帳頁文字推得，實際運費規則待 DB'},'features.json'),
 ('payment',{'methods':[{'id':'ry_ecpay_credit','title':'信用卡','enabled_on_new_site':False}],'real_gateway_connected':False,'note':'新站只建立待付款訂單，未串接金流'},'features.json'),
 ('social',{'facebook':'https://www.facebook.com/p/%E5%8F%B0%E7%81%A3%E5%AE%AE%E5%BB%B7%E9%85%92%E5%BB%A0-100063576617595/','line':'https://line.me/R/ti/p/@uoe1821p'},'html header + chaty'),
 ('floating_buttons',feat['floating_buttons'],'features.json'),
 ('tracking',feat['tracking'],'features.json'),
 ('footer',{'copyright':'承城顧問有限公司版權所有'},'html footer'),
 ('theme',{'name':'Blocksy','companion':'Blocksy Companion Pro','woo_card_layout_price':True,'mega_menu_block_id':2366,'above_footer_block_id':2365,'shop_hero_block_id':512,'shop_categories_hero_block_id':616,'features':feat['other']},'features.json + SITES.json'),
 ('membership',feat['membership'] | {'my_account_url':'/my-account-2/'},'features.json'),
 ('search',{'present':True,'path':'/?s=','post_types':['product','post','page']},'features.json'),
 ('private_data_pending',{'tables':['orders','order_items','order_notes','customers','coupons','discount_rules(details)','authors(details)','menus(wp nav_menu)','form_submissions'],
    'media_hidden_attachment_ids':[1157,1995],'note':'待主控者取得資料庫備份後於第三階段匯入'},'manifest.json gaps')]
rows['settings']=[{'key':k,'value':v,'is_public':k not in ('private_data_pending',),'source':src} for k,v,src in st]
json.dump(rows,open(S+'/rows.json','w'),ensure_ascii=False)
json.dump({'unresolved':unresolved,'missing_img':missing_img},open(S+'/unresolved.json','w'),ensure_ascii=False,indent=1)
print({k:len(v) for k,v in rows.items()}); print('unresolved',len(unresolved), list(unresolved.items())[:40]); print('missing_img',missing_img)
