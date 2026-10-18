"""Same-budget NAR ticket research with train-through-2024 role coefficients."""
from __future__ import annotations
import itertools, json, time
from collections import Counter
from functools import lru_cache
import numpy as np
import pandas as pd
from rein_comprehensive_validation import ROOT,OUT,CACHE,ROLES,PERIODS,periods,dump,cluster_stats,by_adjust,raw_data,baseline_frame
from nar_ticket_research import generate_candidates,normalize
from nar_all_bet_analysis import payout_map,LABELS
from rein_comprehensive_market import stats

POINTS=[1,3,5,10,20,30]
METHODS=['market_only','current_70_30','role_50','role_100','role_formation','selected_70_30']

@lru_cache(maxsize=10)
def permutations(n,k):return np.array(list(itertools.permutations(range(n),k)),dtype=int)

def fast_candidates(horses,roles,popularity,method):
 """Vectorized equivalent of generator; trifecta is research-only extension."""
 horses=np.asarray(horses,int);roles=np.asarray(roles,float)
 market=normalize([1/max(float(p),1) if np.isfinite(p) and p>0 else 1/(len(horses)+1) for p in popularity])
 roles=np.column_stack([normalize(roles[:,i]) for i in range(3)])
 weight={'market_only':0,'current_70_30':.3,'selected_70_30':.3,'role_50':.5,'role_100':1.,'role_formation':1.}[method]
 roles=weight*roles+(1-weight)*market[:,None]
 pool=np.lexsort((horses[:,0],-roles.max(axis=1)))[:9];horses=horses[pool];roles=roles[pool];roles=roles/roles.sum(axis=0)
 n=len(horses);rank=np.empty_like(roles,dtype=int)
 for t in range(3):rank[np.lexsort((horses[:,0],-roles[:,t])),t]=np.arange(1,n+1)
 result={}
 def accumulate(bet,tickets,scores,ordered=False):
  if not ordered:tickets=np.sort(tickets,axis=1)
  # Horse and gate numbers are positive and below 32.
  multipliers=32**np.arange(tickets.shape[1]-1,-1,-1);codes=tickets@multipliers
  unique,inverse=np.unique(codes,return_inverse=True);total=np.bincount(inverse,weights=scores)
  order=np.lexsort((unique,-total));unique=unique[order]
  decoded=[tuple(int(c//m%32) for m in multipliers) for c in unique]
  result[bet]=decoded
 accumulate('win',horses[:,0:1],roles[:,0]);accumulate('place',horses[:,0:1],roles.sum(axis=1))
 pairs=permutations(n,2);i,j=pairs.T
 ok=(rank[i,0]<=3)&(rank[j,1]<=5) if method=='role_formation' else np.ones(len(i),bool)
 i,j=i[ok],j[ok];s=roles[i,0]*roles[j,1]/np.maximum(1-roles[i,1],1e-12)
 hs=np.column_stack([horses[i,0],horses[j,0]]);gs=np.column_stack([horses[i,1],horses[j,1]])
 accumulate('exacta',hs,s,True);accumulate('quinella',hs,s)
 valid=gs[:,0]!=gs[:,1] if method in ['current_70_30','selected_70_30','market_only'] else np.ones(len(gs),bool)
 accumulate('bracket_quinella',gs[valid],s[valid]);accumulate('bracket_exacta',gs,s,True)
 triples=permutations(n,3);i,j,k=triples.T
 ok=(rank[i,0]<=3)&(rank[j,1]<=5)&(rank[k,2]<=5) if method=='role_formation' else np.ones(len(i),bool)
 i,j,k=i[ok],j[ok],k[ok];s=roles[i,0]*roles[j,1]/np.maximum(1-roles[i,1],1e-12)*roles[k,2]/np.maximum(1-roles[i,2]-roles[j,2],1e-12)
 hs=np.column_stack([horses[i,0],horses[j,0],horses[k,0]])
 accumulate('trio',hs,s);accumulate('trifecta',hs,s,True)
 wide=np.concatenate([hs[:,[0,1]],hs[:,[0,2]],hs[:,[1,2]]]);accumulate('wide',wide,np.tile(s,3))
 return result

def generate():
 path=CACHE/'nar-ticket-settlements.parquet'
 if path.exists():return pd.read_parquet(path)
 raw=raw_data('nar');d=baseline_frame('nar',raw)
 selected=pd.read_parquet(CACHE/'nar-selected-scores.parquet')
 d=d.merge(selected[['race_id','horse_number']+[r+'_selected' for r in ROLES]],on=['race_id','horse_number'],how='left',validate='one_to_one')
 d=d.loc[d.race_date.ge('2025-01-01')&d.complete_field&d.surface.ne('ばんえい')&d.field_size.ge(6)]
 rows=[];skipped=Counter();start=time.time();checked=0
 for rid,g in d.groupby('race_id',sort=False):
  if g[['horse_number','gate']+[r+'_selected' for r in ROLES]].isna().any().any():skipped['invalid_inputs']+=1;continue
  try:pay=payout_map(g.payouts.iloc[0])
  except (ValueError,TypeError):skipped['invalid_payouts']+=1;continue
  if not pay:skipped['missing_payouts']+=1;continue
  horses=g[['horse_number','gate']].to_numpy(int);base=g[ROLES].to_numpy();new=g[[r+'_selected' for r in ROLES]].to_numpy();pop=g.popularity.to_numpy()
  for method in METHODS:
   tickets=fast_candidates(horses,new if method=='selected_70_30' else base,pop,method)
   for bet in pay:
    if bet not in tickets:continue
    cand=tickets[bet];returns=np.cumsum([pay[bet].get(t,0.) for t in cand])
    for points in POINTS:
     n=min(points,len(cand))
     if not n:continue
     ret=float(returns[n-1]);rows.append((rid,g.race_date.iloc[0],bet,method,points,n*100,ret,int(ret>0)))
  checked+=1
  if checked%1000==0:print('TICKETS',checked,'seconds',round(time.time()-start),'rows',len(rows),flush=True)
 result=pd.DataFrame(rows,columns=['race_id','date','bet','method','points','stake','return','race_hit'])
 for c in ['race_id','date','bet','method']:result[c]=result[c].astype('category')
 result.to_parquet(path);dump(OUT/'ticket-coverage.json',{'evaluated_races':checked,'skipped':dict(skipped),'records':len(result)});return result

def run():
 d=generate();d['date']=d.date.astype(str);d['period']=periods(d.date.to_numpy())
 allstats=[];lookup={};selected=[]
 for (bet,method,points,p),g in d.groupby(['bet','method','points','period'],observed=True):
  z={'bet':bet,'method':method,'points':int(points),'period':p,**stats(g)};lookup[(bet,method,points,p)]=z;allstats.append(z)
 for bet in d.bet.unique():
  for points in POINTS:
   options=[lookup[(bet,m,points,PERIODS[0])] for m in METHODS if (bet,m,points,PERIODS[0]) in lookup]
   if not options:continue
   # Select only on H1 ROI; exact point budget and identical race set verified below.
   choice=max(options,key=lambda z:(z['roi'],z['hit_rate'],z['method']=='current_70_30'));method=choice['method']
   record={'bet':bet,'points':points,'selected':method,'periods':{}}
   for p in PERIODS:
    a=d.loc[d.bet.eq(bet)&d.points.eq(points)&d.period.eq(p)&d.method.eq(method)]
    b=d.loc[d.bet.eq(bet)&d.points.eq(points)&d.period.eq(p)&d.method.eq('current_70_30')]
    q=a.merge(b,on=['race_id','date'],suffixes=('_a','_b'),validate='one_to_one')
    if len(q)!=len(a) or len(q)!=len(b):raise ValueError('Mismatched comparison fields')
    z=lookup.get((bet,method,points,p));peer=lookup.get((bet,'current_70_30',points,p))
    if not z or not peer:continue
    record['periods'][p]={'candidate':z,'baseline':peer,'equal_actual_stake':bool(q.stake_a.eq(q.stake_b).all()),'paired_hit_gain':cluster_stats(q.race_hit_a-q.race_hit_b,q.date,True),'paired_profit_gain_yen_per_race':cluster_stats((q.return_a-q.stake_a)-(q.return_b-q.stake_b),q.date,True)}
   selected.append(record)
 for p in PERIODS[1:]:
  q=by_adjust([r['periods'].get(p,{}).get('candidate',{}).get('p_one_sided',1.) for r in selected])
  for r,v in zip(selected,q):
   if p in r['periods']:r['periods'][p]['profit_by_q']=v
 for r in selected:
  r['passed']=r['selected']!='current_70_30' and all(p in r['periods'] and r['periods'][p]['candidate']['races']>=500 and r['periods'][p]['candidate']['roi']>1 and r['periods'][p]['profit_by_q']<=.05 and r['periods'][p]['paired_profit_gain_yen_per_race']['ci95'] and r['periods'][p]['paired_profit_gain_yen_per_race']['ci95'][0]>0 and r['periods'][p]['paired_hit_gain']['delta']>=0 and r['periods'][p]['equal_actual_stake'] for p in PERIODS[1:])
 report={'kind':'historical reconstruction, final popularity, actual official payouts; no saved prestart predictions','training':'2019-2024','selection':'2025H1','confirmation':'2025H2','audit':'2026 previously inspected','bets':dict(LABELS),'methods':METHODS,'points':POINTS,'records':len(d),'races':d.race_id.nunique(),'unfiltered_results':allstats,'selected':selected,'strict_passed':sum(r['passed'] for r in selected)}
 dump(OUT/'nar-tickets.json',report);print('TICKET RESULT',report['races'],report['strict_passed'],flush=True)

if __name__=='__main__':run()
