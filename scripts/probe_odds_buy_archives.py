"""Read-only archive inspection for odds buying research, no model publication."""
from pathlib import Path
from urllib.request import Request,urlopen
import os,json,tarfile,io,gzip,hashlib
import pandas as pd

ROOT=Path('artifacts/odds-buy-probe');ROOT.mkdir(parents=True,exist_ok=True)
def post(action,path):
 token=json.load(urlopen(Request(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=rein-supabase-archive-v1',headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}),timeout=30))['value']
 req=Request(os.environ['SUPABASE_BROKER_URL'],data=json.dumps({'action':action,'path':path}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 return json.load(urlopen(req,timeout=45))

def main():
 paths=json.loads(Path('.github/odds-buy-probe-paths.json').read_text())
 reports=[]
 for i,path in enumerate(paths):
  url=post('sign-download',path)['signed_url']
  with urlopen(url,timeout=120) as r:payload=r.read()
  folder=ROOT/str(i);folder.mkdir(exist_ok=True)
  report={'path':path,'sha256':hashlib.sha256(payload).hexdigest(),'bytes':len(payload),'members':[]}
  with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as t:
   html_count=0
   for m in t.getmembers():
    if not m.isfile():continue
    report['members'].append({'name':m.name,'size':m.size})
    if m.name.endswith('.parquet'):
     df=pd.read_parquet(io.BytesIO(t.extractfile(m).read()))
     entry={'name':m.name,'rows':len(df),'columns':df.columns.tolist()}
     if 'bet_type' in df:entry['bet_counts']=df.bet_type.value_counts().to_dict()
     if 'race_id' in df:entry['races']=df.race_id.nunique()
     report.setdefault('parquets',[]).append(entry)
     if 'bet_type' in df:
      sample=df.groupby('bet_type',sort=False).head(6000)
     elif 'race_id' in df:
      ids=df.race_id.drop_duplicates().head(15);sample=df[df.race_id.isin(ids)]
     else:sample=df.head(500)
     sample.to_parquet(folder/Path(m.name).name,index=False)
    elif m.name.endswith('.html.gz') and html_count<12:
     (folder/f'html-{html_count}.html.gz').write_bytes(t.extractfile(m).read());html_count+=1
  (folder/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=int))
  reports.append(report);print(json.dumps({'done':i+1,'path':path,'parquets':report.get('parquets',[])},ensure_ascii=False,default=int),flush=True)
 (ROOT/'report.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2,default=int))
if __name__=='__main__':main()
