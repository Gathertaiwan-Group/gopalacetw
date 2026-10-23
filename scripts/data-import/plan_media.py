import json,re,hashlib,os,sys,collections
E=os.path.expanduser('~/gather-migrate/gopalacetw/export')
lib=json.load(open(E+'/rest/media.json'))
paths=sorted(set(re.sub(r'-scaled(\.\w+)$',r'\1',it['source_url'].split('/wp-content/uploads/')[1]) for it in lib))
def sha(p): return hashlib.sha1(open(p,'rb').read()).hexdigest()
by=collections.defaultdict(list)
for p in paths: by[sha(E+'/media/uploads/'+p)].append(p)
safe=re.compile(r'^[A-Za-z0-9._-]+$')
plan=[];used=set()
for h,ps in by.items():
    canon=sorted(ps)[-1]
    d,b=os.path.split(canon); stem,ext=os.path.splitext(b); ext=ext.lower()
    conv = ext in ('.jpg','.jpeg','.png','.webp')
    if not safe.match(stem): stem='u-'+hashlib.sha1(stem.encode()).hexdigest()[:12]
    newext='.webp' if conv else ext
    key=f'uploads/{d}/{stem}{newext}' if d else f'uploads/{stem}{newext}'
    if key in used: key=key[:-len(newext)]+'-'+ext[1:]+newext
    used.add(key)
    plan.append({'sha1':h,'canonical':canon,'paths':ps,'src':E+'/media/uploads/'+canon,'key':key,'convert':conv})
json.dump(plan,open(sys.argv[1],'w'),ensure_ascii=False,indent=1)
print(len(paths),'paths',len(plan),'unique', sum(len(x['paths'])>1 for x in plan),'dup groups')
