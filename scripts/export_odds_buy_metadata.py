"""Read-only canonical race metadata supplement for the frozen odds audit."""
from pathlib import Path
import sys,io,json,tarfile,re
import pandas as pd
sys.path.insert(0,str(Path(__file__).resolve().parent))
from research_odds_buy import download
NAR_COURSES={3:'帯広',10:'盛岡',11:'水沢',18:'浦和',19:'船橋',20:'大井',21:'川崎',22:'金沢',23:'笠松',24:'名古屋',27:'園田',28:'姫路',31:'高知',32:'佐賀',36:'門別'}
def fetch(item):
 b=download(item['path']);frames=[]
 with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:
  for m in t.getmembers():
   n=Path(m.name).name
   if not m.isfile() or not n.endswith('.parquet'):continue
   if item['league']=='jra':valid=n=='races-2019-2026.parquet'
   else:valid=n.startswith('nar-') and not any(k in n for k in ['-odds-','-payouts','-manifest'])
   if not valid:continue
   x=pd.read_parquet(io.BytesIO(t.extractfile(m).read()));cols=[c for c in ['race_id','race_date','race_no','race_name','racecourse','baba_code','surface','distance_m','course_detail','direction','race_class','race_category','race_conditions','race_rule','weight_rule','going'] if c in x]
   q=x[cols].drop_duplicates('race_id').copy();q['league']=item['league'];q['archive']=item['path']
   if item['league']=='nar':
    codes=pd.to_numeric(q.baba_code,errors='coerce');q['racecourse']=codes.map(NAR_COURSES).fillna(q.racecourse);q.loc[codes.eq(3),'surface']='ばんえい'
   frames.append(q)
 if not frames:raise ValueError('No metadata '+item['path'])
 return pd.concat(frames,ignore_index=True)
def main():
 out=Path('artifacts/odds-buy-metadata');out.mkdir(parents=True,exist_ok=True)
 items=[i for i in json.loads(Path('.github/odds-buy-research-paths.json').read_text()) if i['league']=='nar']
 items.insert(0,{'league':'jra','path':'jra/2019-01-01_2026-09-18/jra-backfill-result.tar.gz'})
 from concurrent.futures import ThreadPoolExecutor,as_completed
 failures=[];frames=[]
 with ThreadPoolExecutor(max_workers=4) as pool:
  futures={pool.submit(fetch,i):i for i in items}
  for n,f in enumerate(as_completed(futures),1):
   try:frames.append(f.result())
   except Exception as e:failures.append({'path':futures[f]['path'],'error':str(e)})
   if n%20==0:print('metadata',n,'/',len(items),'failures',len(failures),flush=True)
 if frames:pd.concat(frames,ignore_index=True).sort_values('archive').drop_duplicates(['league','race_id'],keep='last').to_parquet(out/'race-metadata.parquet',index=False,compression='zstd')
 (out/'failures.json').write_text(json.dumps(failures,ensure_ascii=False,indent=2))
 print('complete',len(items),'failures',len(failures),flush=True)
 if failures:raise SystemExit(1)
if __name__=='__main__':main()
