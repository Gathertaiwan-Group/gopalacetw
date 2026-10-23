import json,os,sys,urllib.request
S=os.path.dirname(os.path.abspath(__file__))
rows=json.load(open(S+'/rows.json'))
TOK=os.environ['SUPABASE_ACCESS_TOKEN']
def q(sql):
    req=urllib.request.Request('https://api.supabase.com/v1/projects/ozwftlkgqmewtadypsfi/database/query',data=json.dumps({'query':sql}).encode(),
        headers={'Authorization':'Bearer '+TOK,'Content-Type':'application/json','User-Agent':'GatherMigrator/1.0'})
    try: return json.loads(urllib.request.urlopen(req,timeout=120).read() or b'null')
    except urllib.error.HTTPError as e: raise SystemExit(f'HTTP {e.code}: {e.read()[:800]}')
SC='site_gopalacetw'
order=['authors','media','media_url_map','terms','attributes','posts','post_terms','products','product_images','product_terms','discount_rules','menus','menu_items','forms','redirects','settings']
q('truncate '+', '.join(f'{SC}.{t}' for t in order)+' restart identity cascade')
for t in order:
    rs=rows[t]
    if not rs: print(t,0); continue
    groups={}
    for r in rs: groups.setdefault(tuple(sorted(r)),[]).append(r)  # 依欄位組合分批，未給的欄位走預設值
    stmts=[]
    for cols,grp in groups.items():
        payload=json.dumps(grp,ensure_ascii=False)
        tag='$gp7q$'; assert tag not in payload
        cl=', '.join(f'"{c}"' for c in cols)
        stmts.append(f'insert into {SC}.{t} ({cl}) select {cl} from jsonb_populate_recordset(null::{SC}.{t}, {tag}{payload}{tag}::jsonb)')
    q(';\n'.join(stmts)); print(t,len(rs),'groups',len(groups))
# 讓 identity 序號跳過已用的 ID
q(f"""do $$ declare r record; m bigint; begin
 for r in select c.relname, a.attname, pg_get_serial_sequence(format('{SC}.%I',c.relname),a.attname) seq
   from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
   where n.nspname='{SC}' and a.attidentity<>'' loop
   execute format('select max(%I) from {SC}.%I', r.attname, r.relname) into m;
   if m is not null then perform setval(r.seq, greatest(m+1, (select start_value from pg_sequences where schemaname||'.'||sequencename = r.seq)), false); end if;
 end loop; end $$""")
q(f"""insert into {SC}.audit_log(actor_type, actor_id, action, entity_type, entity_id, after)
 values ('migration','phase2-data','import','site','gopalacetw', $j${json.dumps({t:len(rows[t]) for t in order})}$j$::jsonb)""")
print('done')
