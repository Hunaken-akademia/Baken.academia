import concurrent.futures,io,json,os,time,tarfile,urllib.request
from pathlib import Path
from plan_nar_resume import build_periods
broker=os.environ['SUPABASE_BROKER_URL']
def post(action,path):
    for attempt in range(5):
        try:
            req=urllib.request.Request(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=rein-supabase-archive-v1',headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
            token=json.load(urllib.request.urlopen(req,timeout=30))['value']
            req=urllib.request.Request(broker,data=json.dumps({'action':action,'path':path}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
            return json.load(urllib.request.urlopen(req,timeout=45))
        except Exception as e:
            if attempt==4: raise
            time.sleep(2*(attempt+1))
def fetch(p):
    path=f"nar/archive/all-bets/v2/{p['year']}/{p['period']}.tar.gz"
    if not post('exists',path).get('exists'):raise RuntimeError('Missing archive '+path)
    for attempt in range(5):
        try:
            url=post('sign-download',path)['signed_url']
            with urllib.request.urlopen(url,timeout=90) as r: b=r.read()
            with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:
                members=[m for m in t.getmembers() if m.isfile() and Path(m.name).name.startswith('nar-') and m.name.endswith('.parquet') and not any(s in m.name for s in ('-odds-','-payouts','-manifest'))]
                if not members:raise RuntimeError('No race parquet '+path)
                for m in members:
                    out=Path('.nar-dataset')/p['period']/Path(m.name).name
                    out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(t.extractfile(m).read())
            return p['period']
        except Exception:
            if attempt==4:raise
            time.sleep(2*(attempt+1))
if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures=[pool.submit(fetch,p) for p in build_periods()]
        for i,f in enumerate(concurrent.futures.as_completed(futures),1):
            print(i,f.result(),flush=True)
