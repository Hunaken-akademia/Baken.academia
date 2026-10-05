"""Research-only rider condition corrections, with strictly prior-day histories.
Exact first/second/third signals vs one shared signal; positive-only vs signed;
H1 selection, H2 confirmation, 2026 previously inspected retrospective audit.
"""
from pathlib import Path
import argparse,json,sys
import numpy as np
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'src'),str(ROOT/'rein-web/api')]
from build_jockey_reference import clean
from rein_accuracy_experiments import jra_dataset,nar_dataset,evaluate,metrics,ROLES
GROUPS={'venueSurface':['racecourse','surface'],'venueDistance':['racecourse','surface','distance'],'turn':['turn'],'gate':['gateBand']}

def prior_counts(d,keys):
 cols=['n','y1','y2','y3'];daily=d.groupby([*keys,'race_date'],observed=True,dropna=False)[cols].sum().reset_index().sort_values('race_date',kind='stable')
 prior=daily.groupby(keys,observed=True,dropna=False)[cols].cumsum()-daily[cols];daily[cols]=prior
 return d[[*keys,'race_date']].merge(daily,on=[*keys,'race_date'],how='left',validate='many_to_one')[cols].to_numpy(dtype=float)

def condition_signals(frame,league):
 d=clean(frame,league).reset_index(drop=True)
 for target in [1,2,3]:d[f'y{target}']=pd.to_numeric(d.finish_position,errors='coerce').eq(target).astype(int)
 base=prior_counts(d,['id']);base_p=(base[:,1:]+1.5)/(base[:,0:1]+20)
 result={}
 for name,cols in GROUPS.items():
  c=prior_counts(d,['id',*cols]);p=(c[:,1:]+50*base_p)/(c[:,0:1]+50)
  logit=lambda v:np.log(np.clip(v,1e-6,1-1e-6)/np.clip(1-v,1e-6,1-1e-6))
  signal=np.clip(logit(p)-logit(base_p),-1,1)*c[:,0:1]/(c[:,0:1]+50)
  valid=(base[:,0]>=30)&(c[:,0]>=20)&~d[cols].isna().any(axis=1).to_numpy()&~d[cols].eq('不明').any(axis=1).to_numpy()
  signal[~valid]=0;result[name]=signal
 result['combined']=np.mean(list(result.values()),axis=0)
 return d[['race_id','horse_number']],result

def rolling_counts(d, keys, days):
 """Whole prior dates within a trailing calendar window; no same-day labels."""
 cols=['n','y1','y2','y3'];daily=d.groupby([*keys,'race_date'],observed=True,dropna=False)[cols].sum().reset_index()
 daily[cols]=daily[cols].astype(float)
 for _,idx in daily.groupby(keys,observed=True,dropna=False).groups.items():
  order=daily.loc[idx].sort_values('race_date').index
  dates=daily.loc[order,'race_date'].to_numpy(dtype='datetime64[D]')
  totals=daily.loc[order,cols].to_numpy();prefix=np.vstack([np.zeros(4),totals.cumsum(axis=0)])
  left=np.searchsorted(dates,dates-np.timedelta64(days,'D'),side='left')
  daily.loc[order,cols]=prefix[np.arange(len(order))]-prefix[left]
 return d[[*keys,'race_date']].merge(daily,on=[*keys,'race_date'],how='left',validate='many_to_one')[cols].to_numpy(dtype=float)

def extended_signals(frame,league):
 d=clean(frame,league).reset_index(drop=True)
 for target in [1,2,3]:d[f'y{target}']=pd.to_numeric(d.finish_position,errors='coerce').eq(target).astype(int)
 d['distanceBand']=pd.cut(pd.to_numeric(d.distance_m,errors='coerce'),[0,1400,1800,2200,np.inf],labels=['短距離','マイル中距離','中距離','長距離']).astype(str)
 for col in ['horse_id','trainer_id']:
  d[col]=d.get(col,pd.Series('',index=d.index)).fillna('').astype(str).str.lstrip('0').replace('nan','')
 base=prior_counts(d,['id']);base_p=(base[:,1:]+1.5)/(base[:,0:1]+20)
 logit=lambda v:np.log(np.clip(v,1e-6,1-1e-6)/np.clip(1-v,1e-6,1-1e-6))
 result={};coverage={}
 specs=[('venuePop',['id','racecourse','surface','popBand'],None,20,50),('distancePop',['id','surface','distanceBand','popBand'],None,20,50),('trainerPair',['id','trainer_id'],None,20,50),('horsePair',['id','horse_id'],None,3,10),('form90',['id'],90,30,50),('form180',['id'],180,50,50),('venueRecent365',['id','racecourse','surface'],365,30,50),('distanceRecent365',['id','surface','distanceBand'],365,30,50)]
 for name,cols,days,minimum,shrink in specs:
  c=rolling_counts(d,cols,days) if days else prior_counts(d,cols)
  # Compare partnerships with the horse/trainer's own prior performance as well.
  reference=base_p
  if name in ['horsePair','trainerPair']:
   other=prior_counts(d,[cols[-1]]);other_p=(other[:,1:]+1.5)/(other[:,0:1]+20)
   reference=(base_p+other_p)/2
  elif 'Pop' in name:
   # Same popularity band rider baseline controls the mix of favorite mounts.
   market=prior_counts(d,['id','popBand']);reference=(market[:,1:]+1.5)/(market[:,0:1]+20)
  p=(c[:,1:]+shrink*reference)/(c[:,0:1]+shrink)
  z=np.clip(logit(p)-logit(reference),-1,1)*c[:,0:1]/(c[:,0:1]+shrink)
  valid=(base[:,0]>=30)&(c[:,0]>=minimum)&~d[cols].isna().any(axis=1).to_numpy()&~d[cols].isin(['','不明','nan','0']).any(axis=1).to_numpy()
  z[~valid]=0;result[name]=z;coverage[name]={'eligibleStarts':int(valid.sum()),'minimum':minimum,'shrink':shrink,'windowDays':days}
 result['extendedCombined']=np.mean(list(result.values()),axis=0)
 return d[['race_id','horse_number']],result,coverage

def correction(base,signal,strength):
 p=np.clip(base,1e-8,1-1e-8);return np.log(p/(1-p))+strength*signal

def candidates(signals,role_index):
 for group,array in signals.items():
  for kind in ['exact','uniform']:
   s=array[:,role_index] if kind=='exact' else array.mean(axis=1)
   for direction in ['positive','signed']:
    z=np.maximum(s,0) if direction=='positive' else s
    for alpha in [.05,.1,.2,.35,.5]:yield f'{group}-{kind}-{direction}-{alpha}',z,alpha

def run(league,out,extended=False):
 if league=='jra':
  d,_,baseline=jra_dataset();raw=pd.read_parquet(next((ROOT/'.second-third-audit/jra').glob('*/data/history.parquet')))
 else:
  d,_,baseline=nar_dataset();paths=[p for p in (ROOT/'.nar-dataset').rglob('nar-*.parquet') if not any(s in p.name for s in ['-odds-','-payouts','-manifest'])];raw=pd.concat([pd.read_parquet(p) for p in paths],ignore_index=True)
 if extended:keys,signals,signal_coverage=extended_signals(raw,league)
 else:keys,signals=condition_signals(raw,league);signal_coverage={}
 # Unknown riders and unsupported surfaces retain the unmodified baseline.
 lookup=pd.MultiIndex.from_frame(keys);wanted=pd.MultiIndex.from_frame(d[['race_id','horse_number']]);indices=lookup.get_indexer(wanted)
 mapped={name:np.vstack([a,np.zeros((1,3))])[np.where(indices<0,len(a),indices)] for name,a in signals.items()}
 mask=d.race_date.ge('2025-01-01').to_numpy();d=d.loc[mask].reset_index(drop=True);baseline={k:v[mask] for k,v in baseline.items()};mapped={k:v[mask] for k,v in mapped.items()}
 report={'league':league,'historyPolicy':'Counts use only completed prior calendar dates; same-day outcomes excluded, including DNF starts as losses. Unknown/unsupported rows receive zero correction. Published all-years UI profiles are not used.','selection':'2025H1 only','confirmation':'2025H2','audit':'2026 retrospective, previously inspected','coverage':{'races':int(d.race_id.nunique()),'runners':len(d)},'roles':{},'uniform':{},'productionModelChanged':False}
 report['experiment']='extended-v2' if extended else 'condition-v1';report['signalCoverage']=signal_coverage
 uniform_choices={}
 for i,role in enumerate(ROLES):
  preds={'current_recipe':baseline[role],'popularity':-pd.to_numeric(d.popularity,errors='coerce').fillna(999).to_numpy()}
  for name,signal,alpha in candidates(mapped,i):preds[name]=correction(baseline[role],signal,alpha)
  print('Evaluating',league,role,len(preds)-2,'corrections',flush=True);result=evaluate(d,preds,i+1);report['roles'][role]=result
  for name,z in result['selection'].items():
   if '-uniform-' in name:uniform_choices.setdefault(name,[]).append(z)
  del preds
 def eligible(values):return len(values)==3 and all(v['all']['top5']['hits']>=report['roles'][r]['selection']['current_recipe']['all']['top5']['hits'] and v['pop4plus']['top5']['hits']>=report['roles'][r]['selection']['current_recipe']['pop4plus']['top5']['hits'] for r,v in zip(ROLES,values))
 choices=[name for name,v in uniform_choices.items() if eligible(v)]
 selected=max(choices,key=lambda name:(sum(v['all']['top5']['hits'] for v in uniform_choices[name]),sum(v['all']['top3']['hits'] for v in uniform_choices[name]),-float(name.split('-')[-1]))) if choices else 'current_recipe'
 report['uniform']['selected']=selected
 for i,role in enumerate(ROLES):
  preds={'current_recipe':baseline[role],'popularity':-pd.to_numeric(d.popularity,errors='coerce').fillna(999).to_numpy()}
  if selected!='current_recipe':
   z=next((s,a) for name,s,a in candidates(mapped,i) if name==selected);preds[selected]=correction(baseline[role],z[0],z[1])
  report['uniform'][role]=evaluate(d,preds,i+1,forced=selected)
 report['decision']='Research only. An offline pass additionally needs serving parity and prospective evidence before activation.'
 out=Path(out);out.mkdir(parents=True,exist_ok=True);(out/f'{league}-jockey-corrections.json').write_text(json.dumps(report,ensure_ascii=False,separators=(',',':')))
 print(json.dumps({role:{'selected':r['selected'],'gate':r['gate']} for role,r in report['roles'].items()}),flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--league',choices=['jra','nar'],required=True);p.add_argument('--output',required=True);p.add_argument('--extended',action='store_true');a=p.parse_args();run(a.league,a.output,a.extended)
