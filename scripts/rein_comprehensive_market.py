"""Long-period audit of archived final-odds policies and 1/2/3-way conditions."""
from __future__ import annotations
import itertools, json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import norm
from rein_comprehensive_validation import ROOT,OUT,CACHE,dump,by_adjust

ARTIFACTS=['11738520332','11738151805','11737911146','11737442430','11737070167','11736909151']
DIMS=['venue','surface','distance_band','going','field_band','season','grade','favorite_band','favorite_gap']

def load():
 cache=CACHE/'final-odds-policies.parquet'
 if cache.exists():return pd.read_parquet(cache)
 m=pd.read_parquet(ROOT/'research-input/11737120265/race-metadata.parquet');m.race_id=m.race_id.astype(str)
 m=m.drop_duplicates(['league','race_id']).set_index(['league','race_id'])
 name=m.race_name.fillna('').astype(str)+' '+m.race_class.fillna('').astype(str)
 m['grade']=np.where(name.str.contains(r'G[ⅠⅡⅢ123]|Jpn|重賞|Ｇ[１２３]|GI|GII|GIII',regex=True),'graded','other')
 m=m[['racecourse','surface','going','distance_m','grade']]
 frames=[]
 needed=['league','race_id','date','bet','policy','field_band','favorite_band','favorite_gap','stake','return','race_hit']
 for artifact in ARTIFACTS:
  for p in (ROOT/'research-input'/artifact).glob('*.parquet'):
   import pyarrow.parquet as pq
   if pq.ParquetFile(p).metadata.num_rows==0:continue
   q=pd.read_parquet(p,columns=needed);q.race_id=q.race_id.astype(str)
   matched=m.reindex(pd.MultiIndex.from_frame(q[['league','race_id']]))
   for dst,src in [('venue','racecourse'),('surface','surface'),('going','going'),('distance','distance_m'),('grade','grade')]:q[dst]=matched[src].to_numpy()
   q=q.loc[q.surface.ne('ばんえい')&q.venue.notna()&q.stake.gt(0)].copy()
   q['distance_band']=pd.cut(q.distance,[-np.inf,1200,1600,2000,2400,np.inf],labels=['<=1200','1201-1600','1601-2000','2001-2400','2401+']).astype(str)
   q['season']=((pd.to_datetime(q.date).dt.month%12)//3).astype(str)
   for col in DIMS+['league','race_id','date','bet','policy']:q[col]=q[col].fillna('unknown').astype('string[pyarrow]')
   frames.append(q)
  print('LOADED MARKET SHARD',artifact,flush=True)
 d=pd.concat(frames,ignore_index=True);del frames,m
 keys=['league','race_id','bet','policy'];duplicates=d.duplicated(keys,keep=False)
 if duplicates.any():
  variants=d.loc[duplicates].groupby(keys)[['stake','return','race_hit']].nunique()
  if (variants>1).any().any():raise ValueError('Conflicting duplicate settlements')
 d=d.drop_duplicates(keys).reset_index(drop=True)
 for col in DIMS+['league','bet','policy']:d[col]=d[col].astype('category')
 d.to_parquet(cache);return d

def stats(g,bootstrap=False):
 stake=float(g.stake.sum());ret=float(g['return'].sum());ratio=ret/stake
 daily=g.groupby('date',observed=True)[['stake','return']].sum();n=len(daily)
 residual=daily['return']-ratio*daily.stake
 se=float(np.sqrt(n/(n-1)*np.sum(residual**2))/stake) if n>1 else np.inf
 p=float(norm.sf((ratio-1)/se)) if se>0 else (0. if ratio>1 else 1.)
 ci=[ratio-1.96*se,ratio+1.96*se]
 if bootstrap and n>=20:
  a=daily[['stake','return']].to_numpy();rng=np.random.default_rng(20261018);ix=rng.integers(n,size=(2000,n));sample=a[ix].sum(axis=1);ci=np.quantile(sample[:,1]/sample[:,0],[.025,.975]).tolist()
 monthly=g.groupby(g.date.str[:7],observed=True)[['stake','return']].sum();cum=(daily['return']-daily.stake).cumsum();peak=np.maximum.accumulate(np.r_[0.,cum.to_numpy()])[1:]
 return {'races':len(g),'days':n,'stake':stake,'return':ret,'roi':ratio,'hit_rate':float(g.race_hit.mean()),'ci95':ci,'p_one_sided':p,'positive_months':int((monthly['return']>monthly.stake).sum()),'months':len(monthly),'max_drawdown_yen':float((peak-cum).max()),'largest_return_share':float(g['return'].max()/ret) if ret else 0.,'roi_without_largest_return':float((ret-g['return'].max())/stake)}

def run():
 d=load();coverage=d.groupby('league',observed=True).agg(races=('race_id','nunique'),records=('race_id','size'),start=('date','min'),end=('date','max')).to_dict('index');print('MARKET COVERAGE',coverage,flush=True)
 report={'kind':'final-odds retrospective only; no prestart saved odds','coverage':coverage,'dimensions':DIMS,'selection_rule':'selection >=100 JRA / >=60 NAR; selection ROI >=1.05; no evaluation date used for selection','gate':'each later period sufficient; ROI>1; BY q<=.05 in every later period; positive bootstrap lower bound; largest return less than half total','leagues':{}}
 checkpoint=OUT/'market-conditions.json'
 if checkpoint.exists():
  old=json.loads(checkpoint.read_text());report['leagues']=old.get('leagues',{})
 for league in ['jra','nar']:
  if league in report['leagues']:
   print('REUSE COMPLETED MARKET',league,flush=True);continue
  a=d.loc[d.league.eq(league)].copy()
  if league=='jra':
   a['period']=np.select([a.date<'2024-01-01',a.date<'2025-01-01',a.date<'2026-01-01'],['selection2019_2023','confirmation2024','audit2025'],default='audit2026');minn=100
   ps=['selection2019_2023','confirmation2024','audit2025','audit2026']
  else:
   a['period']=np.select([a.date<'2026-06-01',a.date<'2026-08-01'],['selection2026FebMay','confirmation2026JunJul'],default='audit2026AugSep');minn=60
   ps=['selection2026FebMay','confirmation2026JunJul','audit2026AugSep']
  sel=a.loc[a.period.eq(ps[0])];searches=0;rules=[];depth_counts={}
  # Group the selection period first; only selected cells incur a full audit.
  for depth in [0,1,2,3]:
   before=searches
   for keys in itertools.combinations(DIMS,depth):
    groupcols=['bet','policy']+list(keys)
    agg=sel.groupby(groupcols,observed=True).agg(n=('race_id','size'),stake=('stake','sum'),ret=('return','sum'))
    agg=agg.loc[agg.n.ge(minn)];searches+=len(agg)
    promising=agg.loc[(agg.ret/agg.stake).ge(1.05)]
    for values,row in promising.iterrows():
     values=values if isinstance(values,tuple) else (values,);mask=np.ones(len(a),bool)
     for col,val in zip(groupcols,values):mask &= a[col].eq(val).to_numpy()
     subset=a.loc[mask];rec={'bet':values[0],'policy':values[1],'conditions':dict(zip(keys,values[2:])),'depth':depth,'periods':{}}
     for p in ps:
      z=subset.loc[subset.period.eq(p)]
      rec['periods'][p]=stats(z) if len(z) else {'races':0,'p_one_sided':1.,'roi':None,'ci95':None}
     rules.append(rec)
   depth_counts[depth]=searches-before;print('MARKET',league,'depth',depth,'tests',searches,'selected',len(rules),flush=True)
  for p in ps[1:]:
   adjusted=by_adjust([r['periods'][p]['p_one_sided'] if r['periods'][p]['races']>=minn else 1. for r in rules])
   for r,q in zip(rules,adjusted):r['periods'][p]['by_q']=q
  for r in rules:
   r['passed']=all(z['races']>=minn and z['roi']>1 and z['by_q']<=.05 and z.get('largest_return_share',1)<.5 for z in [r['periods'][p] for p in ps[1:]])
   if r['passed']:
    mask=a.bet.eq(r['bet'])&a.policy.eq(r['policy'])
    for col,val in r['conditions'].items():mask &= a[col].eq(val)
    for p in ps[1:]:
     ci=stats(a.loc[mask&a.period.eq(p)],True)['ci95'];r['periods'][p]['bootstrap_ci95']=ci
     r['passed'] &= bool(ci[0]>1)
  baseline=[]
  for (bet,policy,p),g in a.groupby(['bet','policy','period'],observed=True):
   baseline.append({'bet':bet,'policy':policy,'period':p,**stats(g)})
  report['leagues'][league]={'periods':ps,'tests':searches,'tests_by_depth':depth_counts,'selection_passed':len(rules),'strict_passed':sum(r['passed'] for r in rules),'rules':rules,'unfiltered_policies':baseline}
  dump(OUT/'market-conditions.json',report)
  print('MARKET RESULT',league,searches,len(rules),sum(r['passed'] for r in rules),flush=True)

if __name__=='__main__':run()
