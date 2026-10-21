"""Exact incremental NAR history profiles; fixed production coefficients.
Initial bootstrap uses archived history once. Later refreshes read only the small
aggregate state and newly completed daily archives. No rounded-rate reversal.
"""
import gzip,hashlib,html,io,json,os,random,re,tarfile,time,unicodedata,urllib.request
from pathlib import Path
from datetime import datetime,timedelta,timezone
import pandas as pd
from baken_academia.rein_history import _key
from nar_live_model import normalize_courses

PEDIGREE_URL='https://www.keiba.go.jp/KeibaWeb/DataRoom/RaceHorseInfo'
# Sire progeny counts are sums of each offspring's exact horse-level counts.
SIRE_GROUPS={'sire':'horse','sireSurface':'horseSurface','sireDistance':'horseDistance','sireCourse':'horseCourse'}
GROUPS={'horse':['horse_id'],'horseSurface':['horse_id','surface'],'horseDistance':['horse_id','distance_bucket'],'horseCourse':['horse_id','racecourse'],'jockey':['jockey_id'],'trainer':['trainer_id'],'course':['racecourse','surface','distance_bucket','going'],'gate':['racecourse','surface','distance_bucket','gate']}


def lineage_name(value):
    # Same key as the web runtime: the card and horse pages differ only in spacing.
    return re.sub(r'\s+','',unicodedata.normalize('NFKC',html.unescape(value or '')))


def parse_pedigree(page):
    """[sire, dam sire] from the official horse page, or None if no pedigree table."""
    sire=re.search(r'class="fathername"[^>]*>([^<]*)<',page)
    dam_sire=re.search(r'>\s*母父\s*</td>\s*<td[^>]*>([^<]*)<',page)
    if not sire or not html.unescape(sire.group(1)).strip():return None
    return [html.unescape(sire.group(1)).strip(),html.unescape(dam_sire.group(1)).strip() if dam_sire else '']


def collect_pedigrees(state,priority,budget_seconds,fetch=None,delay=(3.0,4.0),clock=time.monotonic,sleep=time.sleep):
    """Fill state['pedigree'] politely within a time budget; the rest waits for the next refresh."""
    pedigree=state.setdefault('pedigree',{});fetch=fetch or (lambda horse:get(f'{PEDIGREE_URL}?k_lineageLoginCode={horse}&k_activeCode=1').decode('utf-8','replace'))
    counts=state['counts']['horse'];seen=set();queue=[]
    for horse in [*priority,*sorted(state.get('knownHorses',[]),key=lambda h:-counts.get(_key(h),[0])[0])]:
        key=_key(horse)
        if key and key not in pedigree and key not in seen:seen.add(key);queue.append(str(horse))
    deadline=clock()+budget_seconds;added=failures=streak=0
    for horse in queue:
        if clock()>=deadline or streak>=20:break
        try:
            found=parse_pedigree(fetch(horse));streak=0
            # A page without a pedigree table is recorded so it is not refetched daily.
            pedigree[_key(horse)]=found or ['',''];added+=bool(found)
        except Exception as exc:
            failures+=1;streak+=1;print('Pedigree unavailable',horse,exc,flush=True)
        sleep(random.uniform(*delay))
    return {'added':added,'failures':failures,'remaining':sum(_key(h) not in pedigree for h in queue)}


def sire_counts(state):
    pedigree=state.get('pedigree',{});output={group:{} for group in SIRE_GROUPS}
    for group,source in SIRE_GROUPS.items():
        for key,value in state['counts'][source].items():
            horse,_,rest=key.partition('|');sire=lineage_name((pedigree.get(horse) or [''])[0])
            if not sire:continue
            key=sire+('|'+rest if rest else '');old=output[group].get(key,[0,0,0,0])
            output[group][key]=[a+b for a,b in zip(old,value)]
    return output


def broker(body):
    req=urllib.request.Request(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=rein-supabase-archive-v1',headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(req,timeout=30) as r:token=json.load(r)['value']
    req=urllib.request.Request(os.environ['SUPABASE_SERVER_BROKER_URL'],data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=45) as r:return json.load(r)


def get(url):
    with urllib.request.urlopen(url,timeout=90) as r:return r.read()


def normalize(d):
    d=normalize_courses(d.copy());d['race_date']=pd.to_datetime(d.race_date)
    d=d.sort_values(['race_date','race_id','horse_number']).drop_duplicates(['race_id','horse_id'],keep='last')
    d['distance_bucket']=(pd.to_numeric(d.distance_m)//200).astype('Int64')
    return d


def append(state,raw):
    d=normalize(raw)
    if state['meta'].get('dateTo') and d.race_date.min()<=pd.Timestamp(state['meta']['dateTo']):raise ValueError('History dates overlap; update rejected')
    valid=d.loc[d.finish_position.notna()].copy();valid['_w']=valid.finish_position.eq(1).astype(int);valid['_t']=valid.finish_position.between(1,3).astype(int)
    for group,keys in GROUPS.items():
        stats=valid.groupby(keys,dropna=False,observed=True).agg(n=('finish_position','size'),w=('_w','sum'),t=('_t','sum'),f=('finish_position','sum'))
        destination=state['counts'][group]
        for key,row in stats.iterrows():
            parts=key if isinstance(key,tuple) else (key,);key='|'.join(_key(v) for v in parts)
            old=destination.get(key,[0,0,0,0]);destination[key]=[int(old[i]+row[k]) for i,k in enumerate(['n','w','t','f'])]
    for horse,g in valid.groupby('horse_id',sort=False):
        key=_key(horse);state['recent'][key]=(state['recent'].get(key,[])+g.finish_position.astype(int).tolist())[-5:]
    known=set(state.get('knownHorses',[]));known.update(str(x) for x in d.horse_id.dropna().unique());state['knownHorses']=sorted(known)
    m=state['meta'];m['dateFrom']=m.get('dateFrom') or str(d.race_date.min().date());m['dateTo']=str(d.race_date.max().date())
    m['races']+=int(d.race_id.nunique());m['runners']+=len(d);m['horses']=len(state['knownHorses'])
    return state


def profile(state):
    def rate(v):
        n,w,t,f=v
        return dict(n=n,w=round((w+1.5)/(n+20),5),t=round((t+4.5)/(n+20),5),f=round(f/n,3))
    output={'meta':{**state['meta'],'version':'history-v2','leakagePolicy':'target race dateより前の確定結果のみ'}}
    output.update({group:{key:rate(v) for key,v in rows.items()} for group,rows in state['counts'].items()})
    if state.get('pedigree'):
        sires=sire_counts(state);output.update({group:{key:rate(v) for key,v in rows.items()} for group,rows in sires.items()})
        starts=sum(v[0] for v in state['counts']['horse'].values())
        output['meta']['pedigreeCoverage']=round(sum(v[0] for v in sires['sire'].values())/starts,4) if starts else 0
    output['horseRecent5']={key:rate([len(v),sum(x==1 for x in v),sum(1<=x<=3 for x in v),sum(v)]) for key,v in state['recent'].items()}
    return output


def main():
    current=broker({'action':'nar-history-current'});out=Path('artifacts/nar-profile-refresh');out.mkdir(parents=True,exist_ok=True)
    previous=current['dateTo'];now=datetime.now(timezone(timedelta(hours=9)));end=now.date()-timedelta(days=now.hour<22)
    if pd.Timestamp(previous).date()>=end:
        (out/'summary.json').write_text(json.dumps({'status':'unchanged','historyThrough':previous}));return
    if (end-pd.Timestamp(previous).date()).days>30:raise ValueError('NAR daily refresh gap exceeds 30 days')
    if current.get('state_url'):
        raw=get(current['state_url'])
        if hashlib.sha256(raw).hexdigest()!=current['stateSha']:raise ValueError('State checksum mismatch')
        state=json.loads(gzip.decompress(raw))
        if state.get('schema')!=1 or set(state['counts'])!=set(GROUPS):raise ValueError('Unsupported aggregate state')
        if state['meta']['dateTo']!=previous:raise ValueError('State/profile dates differ')
    else:
        # Reuse the audited four-way archive downloader only for initial bootstrap.
        from download_recall_archives import fetch
        from plan_nar_resume import build_periods
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for i,value in enumerate(pool.map(fetch,build_periods()),1):print('Bootstrap archive',i,value,flush=True)
        paths=[p for p in Path('.nar-dataset').rglob('nar-*.parquet') if not any(s in p.name for s in ['-odds-','-payouts','-manifest'])]
        d=pd.concat([pd.read_parquet(p) for p in paths],ignore_index=True);d=d.loc[pd.to_datetime(d.race_date).le(previous)]
        state={'schema':1,'meta':dict(races=0,runners=0,horses=0),'counts':{g:{} for g in GROUPS},'recent':{}}
        state=append(state,d)
    initial_races=state['meta']['races'];initial_rows=state['meta']['runners'];recent=[]
    day=pd.Timestamp(previous).date()+timedelta(days=1)
    while day<=end:
        path=f'daily/nar/{day.year}/{day}.tar.gz'
        signed=broker({'action':'nar-daily-download','path':path})
        archive=get(signed['signed_url'])
        with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as t:
            members=[m for m in t.getmembers() if m.isfile() and Path(m.name).name=='races.parquet']
            if len(members)!=1:raise ValueError('Daily archive must contain one race table')
            d=pd.read_parquet(io.BytesIO(t.extractfile(members[0]).read()))
        if not pd.to_datetime(d.race_date).dt.date.eq(day).all():raise ValueError('Unexpected daily archive date')
        state=append(state,d);recent+=[str(h) for h in d.horse_id.dropna().unique()];print('Added day',day,flush=True);day+=timedelta(days=1)
    # Newest runners first, then horses with the most starts in the aggregates.
    pedigree=collect_pedigrees(state,recent[::-1],float(os.environ.get('NAR_PEDIGREE_BUDGET_MINUTES','20'))*60)
    print('Pedigrees',json.dumps(pedigree),flush=True)
    payload=profile(state)
    for kind,value in [('profile',payload),('state',state)]:
        raw=gzip.compress(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode(),compresslevel=9,mtime=0)
        if len(raw)>16_000_000:raise ValueError('Profile/state too large')
        sha=hashlib.sha256(raw).hexdigest();upload=broker({'action':'nar-profile-upload','sha':sha,'kind':kind})
        req=urllib.request.Request(upload['signed_url'],data=raw,method='PUT',headers={'Content-Type':'application/gzip','x-upsert':'true'})
        with urllib.request.urlopen(req,timeout=90) as response:response.read()
        if kind=='profile':profile_sha=sha
        else:state_sha=sha
    result=broker({'action':'publish-nar-history','previousSha':current['profileSha'],'profileSha':profile_sha,'stateSha':state_sha,'meta':payload['meta']})
    if not result.get('published'):raise ValueError('Profile publication failed')
    summary={'status':'refreshed','previousHistoryThrough':previous,'historyThrough':payload['meta']['dateTo'],'addedRaces':state['meta']['races']-initial_races,'addedRunners':state['meta']['runners']-initial_rows,'coefficientsUnchanged':True,'pedigree':pedigree,'pedigreeCoverage':payload['meta'].get('pedigreeCoverage'),'profileSha':profile_sha,'stateSha':state_sha}
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
