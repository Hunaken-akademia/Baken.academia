"""Descriptive jockey profiles; exact counts, no production prediction changes.
Reference periods are explicit. 2019-2024 -> 2025/2026 stability is audited
separately from the all-history UI summaries. Raw rows are never exported.
"""
from pathlib import Path
import argparse, base64, gzip, json, re
import numpy as np
import pandas as pd
COURSES={3:'帯広',10:'盛岡',11:'水沢',18:'浦和',19:'船橋',20:'大井',21:'川崎',22:'金沢',23:'笠松',24:'名古屋',27:'園田',28:'姫路',31:'高知',32:'佐賀',36:'門別'}
GROUPS={'all':[], 'venue':['racecourse'],'surface':['surface'],'distance':['distance'],'turn':['turn'],'gate':['gateBand'],'venueSurface':['racecourse','surface'],'venueDistance':['racecourse','surface','distance']}

def clean(frame,league):
 d=frame.copy();d['race_date']=pd.to_datetime(d.race_date);d=d.drop_duplicates(['race_id','horse_number']).sort_values(['race_date','race_id','horse_number'])
 if league=='nar':
  codes=pd.to_numeric(d.get('baba_code'),errors='coerce');d['racecourse']=codes.map(COURSES).fillna(d.racecourse);d.loc[codes.eq(3),'surface']='ばんえい'
 d=d.loc[~d.surface.isin(['ばんえい','障害'])].copy()
 for c in ['jockey_id','jockey_name']:
  if c not in d: d[c]=''
 d['id']=d.jockey_id.fillna('').astype(str).str.replace(r'^0+','',regex=True);d['name']=d.jockey_name.fillna('').astype(str).str.replace(r'\s+','',regex=True)
 d=d.loc[d.id.ne('')].copy()
 finish=pd.to_numeric(d.finish_position,errors='coerce');status=d.get('finish_status',pd.Series('',index=d.index)).fillna('').astype(str)
 d=d.loc[finish.gt(0)|status.str.contains('中止|失格|タイムオーバー')].copy();finish=pd.to_numeric(d.finish_position,errors='coerce')
 d['n']=1;d['w']=finish.eq(1).astype(int);d['p']=finish.between(1,2).astype(int);d['t']=finish.between(1,3).astype(int)
 d['distance']=pd.to_numeric(d.distance_m,errors='coerce').astype('Int64').astype(str).replace('<NA>','不明')
 detail=d.get('direction',d.get('course_detail',pd.Series('',index=d.index))).fillna('').astype(str)
 d['turn']=np.select([detail.str.contains('左'),detail.str.contains('右'),detail.str.contains('直')],['左回り','右回り','直線'],default='不明')
 gate=pd.to_numeric(d.gate,errors='coerce');d['gateBand']=np.select([gate.between(1,2),gate.between(3,6),gate.between(7,8)],['内枠（1〜2）','中枠（3〜6）','外枠（7〜8）'],default='不明')
 pop=pd.to_numeric(d.get('popularity',pd.Series(np.nan,index=d.index)),errors='coerce');d['popBand']=np.select([pop.between(1,3),pop.between(4,6),pop.ge(7)],['1〜3番人気','4〜6番人気','7番人気以下'],default='不明')
 return d

def rates(d,keys):
 g=d.groupby(['id',*keys],observed=True,dropna=False)[['n','w','p','t']].sum()
 return [('' if len(keys)==0 else '|'.join(str(x) for x in idx[1:]),str(idx[0] if isinstance(idx,tuple) else idx),[int(x) for x in row]) for idx,row in g.iterrows()]

def build(frame,league):
 d=clean(frame,league);profiles={}
 for ident,g in d.groupby('id',sort=False):profiles[str(ident)]={'name':g.name.iloc[-1],'groups':{}}
 for group,keys in GROUPS.items():
  for condition,ident,counts in rates(d,keys):profiles[ident]['groups'].setdefault(group,{})[condition]=counts
 # Audit whether conditions stronger than the rider's own total in 2019-24
 # continue in independent later periods; no coefficient/prediction activation.
 train=d.loc[d.race_date.lt('2025-01-01')];audit={}
 for group in ['venueSurface','venueDistance','turn','gate']:
  keys=GROUPS[group];summary={};base=train.groupby('id')[['n','t']].sum();g=train.groupby(['id',*keys])[['n','t']].sum()
  selected=g.loc[g.n.ge(50)].copy();selected['base']=selected.index.get_level_values(0).map(base.t/base.n);selected=selected.loc[selected.t/selected.n>=selected.base+0.03]
  for label,start,end in [('2025','2025-01-01','2026-01-01'),('2026','2026-01-01','2027-01-01')]:
   q=d.loc[d.race_date.ge(start)&d.race_date.lt(end)].copy();idx=pd.MultiIndex.from_frame(q[['id',*keys]]);q=q.loc[idx.isin(selected.index)]
   expected=q.id.map(base.t/base.n);summary[label]={'starts':len(q),'top3':int(q.t.sum()),'top3Rate':float(q.t.mean()) if len(q) else None,'riderTrainingBaseline':float(expected.mean()) if len(q) else None}
  audit[group]=summary
 meta={'version':'jockey-reference-v1','league':league,'dateFrom':str(d.race_date.min().date()),'dateTo':str(d.race_date.max().date()),'starts':len(d),'races':int(d.race_id.nunique()),'jockeys':len(profiles),'definition':'出走取消・除外は除く。中止・失格は出走数に含む。各率は平滑化なしの実績。得意条件の予測補正は未採用。'}
 return {'meta':meta,'jockeys':profiles}, {'meta':meta,'temporalAudit':audit,'decision':'Reference display only; rider/horse ability and popularity mix are not controlled. No prediction uplift claim.'}

def main():
 p=argparse.ArgumentParser();p.add_argument('--league',choices=['jra','nar'],required=True);p.add_argument('--input');p.add_argument('--output',required=True);a=p.parse_args()
 if a.input:d=pd.read_parquet(a.input)
 else:
  paths=[p for p in Path('.nar-dataset').rglob('nar-*.parquet') if not any(s in p.name for s in ['-odds-','-payouts','-manifest'])]
  d=pd.concat([pd.read_parquet(p) for p in paths],ignore_index=True)
 payload,report=build(d,a.league);out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
 raw=json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode();(out/f'{a.league}-jockey-reference.json.gz.b64').write_text(base64.b64encode(gzip.compress(raw,mtime=0)).decode()+'\n')
 (out/f'{a.league}-jockey-reference-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({**report['meta'],'encodedBytes':(out/f'{a.league}-jockey-reference.json.gz.b64').stat().st_size},ensure_ascii=False))
if __name__=='__main__':main()
