"""Archive-by-archive odds-only betting audit; official payouts, research only."""
from pathlib import Path
from urllib.request import Request,urlopen
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from collections import defaultdict,Counter
import argparse,json,os,io,gzip,tarfile,re,hashlib,time,sys,unicodedata
import numpy as np,pandas as pd
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from baken_academia.jra_backfill import parse_results_page
from baken_academia.jra_all_payouts import parse_all_payouts
from odds_buy_market import parse_jra,parse_nar,payout_key,market_probabilities,ARITY

COURSES={'01':'札幌','02':'函館','03':'福島','04':'新潟','05':'東京','06':'中山','07':'中京','08':'京都','09':'阪神','10':'小倉'}
ODDS_BANDS=[(1,1.5),(1.5,2),(2,3),(3,5),(5,10),(10,20),(20,50),(50,100),(100,300),(300,1000000)]

def post(action,path):
 for attempt in range(4):
  try:
   token=json.load(urlopen(Request(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=rein-supabase-archive-v1',headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}),timeout=30))['value']
   req=Request(os.environ['SUPABASE_BROKER_URL'],data=json.dumps({'action':action,'path':path}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
   return json.load(urlopen(req,timeout=60))
  except Exception:
   if attempt==3:raise
   time.sleep(2*(attempt+1))

def download(path):
 for attempt in range(4):
  try:
   url=post('sign-download',path)['signed_url']
   with urlopen(url,timeout=180) as r:return r.read()
  except Exception:
   if attempt==3:raise
   time.sleep(2*(attempt+1))

def jra_id(row):return f"{pd.Timestamp(row['race_date']):%Y%m%d}-{COURSES[str(row['course_code']).zfill(2)]}-{int(row['race_no']):02d}"

def read_archive(payload,path,league):
 market=defaultdict(dict);race_rows=[];payout_rows=[];source_pages={};audit=Counter();manifest=None
 with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as t:
  members=t.getmembers()
  # Only small normalized manifests/races/payouts. Raw million-cell tables are not loaded.
  for m in members:
   if not m.isfile() or not m.name.endswith('.parquet') or 'cells' in m.name:continue
   name=Path(m.name).name
   if league=='jra' and name=='pages.parquet':
    q=pd.read_parquet(io.BytesIO(t.extractfile(m).read()));manifest=q
    for row in q.to_dict('records'):source_pages[Path(row['raw_path']).name]=(jra_id(row),row['bet_type'],row.get('raw_sha256'))
   elif league=='nar' and name.endswith('-odds-manifest.parquet'):
    q=pd.read_parquet(io.BytesIO(t.extractfile(m).read()));manifest=q
    for row in q.to_dict('records'):source_pages[Path(row['raw_path']).name]=(str(row['race_id']),row['bet_type'],None)
   elif league=='nar' and name.startswith('nar-') and not any(k in name for k in ['-odds-','-payouts','-manifest']):race_rows.extend(pd.read_parquet(io.BytesIO(t.extractfile(m).read())).to_dict('records'))
   elif name.endswith('payouts.parquet'):
    payout_rows.extend(pd.read_parquet(io.BytesIO(t.extractfile(m).read())).to_dict('records'))
  for m in members:
   if not m.isfile() or not m.name.endswith('.html.gz'):continue
   data=gzip.decompress(t.extractfile(m).read());entry=source_pages.get(Path(m.name).name)
   if entry:
    rid,bet,digest=entry
    if digest and hashlib.sha256(data).hexdigest()!=digest:raise ValueError('Saved page checksum mismatch')
    found=parse_jra(data,bet) if league=='jra' else parse_nar(data,bet)
    if not found:audit['unusable_odds_page_'+bet]+=1
    for b,values in found.items():
     key=(rid,b)
     if key in market and market[key]!=values:raise ValueError('Conflicting archived odds pages')
     market[key]=values
   elif league=='jra' and b'race_result_' in data:
    race_rows.extend(parse_results_page(data,'saved:'+path))
    # Older chunks have no normalized payouts: recover actual official refunds from cached results.
    payout_rows.extend(parse_all_payouts(data,'saved:'+path))
 if not race_rows:raise ValueError('Archive has no verified race metadata')
 raw=pd.DataFrame(race_rows).drop_duplicates(['race_id','horse_number'])
 if league=='nar':
  # Historical result pages retain actual final win odds even when auxiliary pages expired.
  for rid,g in raw.groupby('race_id',sort=False):
   if (str(rid),'win') not in market:
    vals={}
    for r in g.to_dict('records'):
     value=r.get('win_odds')
     if value is not None and pd.notna(value) and float(value)>=1:vals[(int(r['horse_number']),)]=(float(value),float(value))
    if vals:market[(str(rid),'win')]=vals;audit['win_from_official_result_races']+=1
 payouts=defaultdict(dict)
 for row in payout_rows:
  value=payout_key(row,league)
  if value:
   rid,b,sel,yen=value
   if sel in payouts[(rid,b)] and payouts[(rid,b)][sel]!=yen:raise ValueError('Conflicting official payouts')
   payouts[(rid,b)][sel]=yen
 audit['raw_races']=raw.race_id.nunique();audit['markets']=len(market);audit['payout_markets']=len(payouts)
 return raw,market,payouts,dict(audit)

def metadata(group,league):
 first=group.iloc[0];title=unicodedata.normalize('NFKC',str(first.get('race_name','')))
 if league=='jra':cls=str(first.get('race_class',''));cls={'500万円以下':'1勝クラス','1000万円以下':'2勝クラス','1600万円以下':'3勝クラス'}.get(cls,cls)
 else:
  matches=re.findall(r'(?<![A-Z])([ABC][1-3])(?!\d)',title)
  cls='/'.join(dict.fromkeys(matches)) if matches else '新馬' if '新馬' in title else '2歳' if '2歳' in title else '3歳' if '3歳' in title else '重賞' if any(s in title for s in ['Jpn','G1','G2','G3','重賞']) else 'その他'
 distance=int(first.distance_m);field=len(group);detail=str(first.get('course_detail',first.get('direction','')))
 layout='外' if '外' in detail else '内' if '内' in detail else '不明';direction='左' if '左' in detail else '右' if '右' in detail else '不明'
 return {'league':league,'race_id':str(first.race_id),'date':str(pd.Timestamp(first.race_date).date()),'year':pd.Timestamp(first.race_date).year,'venue':str(first.racecourse),'surface':'ばんえい' if str(first.racecourse)=='帯広' else str(first.surface),'distance':distance,'distance_band':'〜1400' if distance<=1400 else '1401〜1800' if distance<=1800 else '1801〜2400' if distance<=2400 else '2401〜','class':cls,'going':str(first.get('going','不明')),'field_band':'〜9頭' if field<=9 else '10〜13頭' if field<=13 else '14頭〜','layout':layout,'direction':direction,'course':f'{first.racecourse}|{first.surface}|{distance}|{direction}|{layout}'}

def policies(odds,probs):
 n=len(odds);rank=np.arange(n)
 yield '人気1位',rank[:1]
 yield '人気2〜3位',rank[1:3]
 yield '人気4〜5位',rank[3:5]
 yield '人気6〜10位',rank[5:10]
 yield '人気11〜20位',rank[10:20]
 yield '人気上位3点',rank[:3]
 for lo,hi in ODDS_BANDS:
  ids=rank[(odds>=lo)&(odds<hi)][:3]
  if len(ids):yield f'オッズ{lo:g}〜{hi:g}未満・最大3点',ids
 for ev in [1.1,1.2,1.5]:
  ids=rank[(odds*probs>=ev)&(odds<=100)][:3]
  if len(ids):yield f'単勝市場比EV{ev:g}以上・100倍以下・最大3点',ids

def evaluate_archive(raw,market,payouts,league):
 records=[];skipped=Counter();coverage=Counter()
 for rid,g in raw.groupby('race_id',sort=False):
  rid=str(rid)
  statuses=g.get('finish_status',pd.Series('',index=g.index)).astype(str)
  # Dedicated refund/dead-heat handling is required before using these races for rules.
  if statuses.str.contains('取消|除外').any() or g.get('is_dead_heat',pd.Series(False,index=g.index)).fillna(False).any():skipped['cancellation_or_dead_heat']+=1;continue
  if g.horse_number.duplicated().any() or g.gate.isna().any():skipped['invalid_roster']+=1;continue
  win=market.get((rid,'win'),{});numbers=set(g.horse_number.astype(int));winmap={s[0]:o[0] for s,o in win.items() if s[0] in numbers}
  if len(winmap)!=len(numbers) or len(numbers)<3:skipped['incomplete_win_odds']+=1;continue
  meta=metadata(g,league);ordered=sorted(winmap,key=lambda h:(winmap[h],h));favorite=winmap[ordered[0]];ratio=winmap[ordered[1]]/favorite
  meta['favorite_band']='〜1.9' if favorite<2 else '2.0〜2.2' if favorite<2.3 else '2.3〜2.9' if favorite<3 else '3.0〜3.5' if favorite<3.6 else '3.6〜4.9' if favorite<5 else '5.0〜'
  meta['favorite_gap']='僅差' if ratio<1.3 else '小差' if ratio<1.7 else '中差' if ratio<2.5 else '大差'
  gate=dict(zip(g.horse_number.astype(int),g.gate.astype(int)))
  for bet in ARITY:
   prices=market.get((rid,bet));pay=payouts.get((rid,bet))
   if not prices or not pay:continue
   if not all(s in prices for s in pay):skipped['winning_selection_missing_from_odds_'+bet]+=1;continue
   # Strong association check: single-price winning quote must agree with actual payout,
   # allowing normal rounding/bonus variation. Never substitute the quote as settlement.
   if bet not in ['place','wide'] and any(abs(prices[s][0]*100-y)>max(10,.06*y) for s,y in pay.items()):skipped['winning_quote_payout_mismatch_'+bet]+=1;continue
   selections=sorted(prices,key=lambda s:(prices[s][0],s));valid=[s for s in selections if bet.startswith('bracket') or set(s)<=numbers]
   if len(valid)!=len(selections):skipped['odds_selection_outside_roster_'+bet]+=1;continue
   odds=np.array([prices[s][0] for s in selections]);probs=market_probabilities(winmap,bet,selections,gate,2 if len(numbers)<8 else 3)
   returns=np.array([pay.get(s,0) for s in selections]);coverage[bet]+=1
   for policy,ids in policies(odds,probs):
    if not len(ids):continue
    selected_return=float(returns[ids].sum());hits=int((returns[ids]>0).sum());stake=int(len(ids)*100)
    records.append({**meta,'bet':bet,'policy':policy,'tickets':len(ids),'stake':stake,'return':selected_return,'hits':hits,'race_hit':int(hits>0),'max_ticket_return':float(returns[ids].max()),'odds_sum':float(odds[ids].sum())})
 return pd.DataFrame(records),dict(skipped),dict(coverage)

def run_chunk(item,out):
 path=item['path'];league=item['league'];slug=hashlib.sha256(path.encode()).hexdigest()[:16];destination=out/(slug+'.parquet');audit_file=out/(slug+'.json')
 if destination.exists() and audit_file.exists():return path
 payload=download(path);raw,market,payouts,audit=read_archive(payload,path,league);records,skipped,coverage=evaluate_archive(raw,market,payouts,league)
 if not records.empty:records['archive']=path;records.to_parquet(destination,index=False,compression='zstd')
 else:pd.DataFrame(columns=['race_id','bet','policy','archive']).to_parquet(destination,index=False)
 result={'path':path,'league':league,'archive_bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest(),'audit':audit,'skipped':skipped,'coverage':coverage,'records':len(records)};audit_file.write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False),flush=True)
 return path

def main():
 p=argparse.ArgumentParser();p.add_argument('--shard',type=int,required=True);p.add_argument('--shards',type=int,default=6);p.add_argument('--limit',type=int);p.add_argument('--workers',type=int,default=2);a=p.parse_args()
 items=json.loads(Path('.github/odds-buy-research-paths.json').read_text());items=items[a.shard::a.shards]
 if a.limit:items=items[:a.limit]
 out=Path(f'artifacts/odds-buy-shard-{a.shard}');out.mkdir(parents=True,exist_ok=True);failures=[]
 with ThreadPoolExecutor(max_workers=a.workers) as pool:
  futures={pool.submit(run_chunk,item,out):item for item in items}
  from concurrent.futures import as_completed
  for future in as_completed(futures):
   try:future.result()
   except Exception as error:
    failures.append({'path':futures[future]['path'],'error':str(error)});print(json.dumps(failures[-1]),flush=True)
 (out/'failures.json').write_text(json.dumps(failures,ensure_ascii=False,indent=2))
 print(json.dumps({'shard':a.shard,'scheduled':len(items),'failures':len(failures)}),flush=True)
 if failures:raise SystemExit(1)
if __name__=='__main__':main()
