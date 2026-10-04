"""Exact incremental NAR history profiles; fixed production coefficients.
Initial bootstrap uses archived history once. Later refreshes read only the small
aggregate state and newly completed daily archives. No rounded-rate reversal.
"""
import gzip,hashlib,io,json,os,tarfile,urllib.request
from pathlib import Path
from datetime import datetime,timedelta,timezone
import pandas as pd
from baken_academia.rein_history import _key
from nar_live_model import normalize_courses

GROUPS={'horse':['horse_id'],'horseSurface':['horse_id','surface'],'horseDistance':['horse_id','distance_bucket'],'horseCourse':['horse_id','racecourse'],'jockey':['jockey_id'],'trainer':['trainer_id'],'course':['racecourse','surface','distance_bucket','going'],'gate':['racecourse','surface','distance_bucket','gate']}


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
    initial_races=state['meta']['races'];initial_rows=state['meta']['runners']
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
        state=append(state,d);print('Added day',day,flush=True);day+=timedelta(days=1)
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
    summary={'status':'refreshed','previousHistoryThrough':previous,'historyThrough':payload['meta']['dateTo'],'addedRaces':state['meta']['races']-initial_races,'addedRunners':state['meta']['runners']-initial_rows,'coefficientsUnchanged':True,'profileSha':profile_sha,'stateSha':state_sha}
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
