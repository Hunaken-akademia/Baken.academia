"""Reproducible retrospective REIN research; never activates serving changes.

All new coefficients use 2019-2024. Pick rules on 2025H1, confirm on H2,
then audit 2026 (previously inspected, NOT a pristine holdout). Final popularity
is used only for outsider evaluation and explicitly labelled ticket experiments.
"""
from __future__ import annotations
import argparse, itertools, json, math
from pathlib import Path
from collections import Counter
import numpy as np
import pandas as pd
from scipy.stats import norm

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/rein-comprehensive-20261018'
CACHE = ROOT / 'research-cache'
ROLES = ['first', 'second', 'third']
PERIODS = ['selection2025H1', 'confirmation2025H2', 'retrospective2026']
BASE_GROUPS = {
 'horse':['horse_id'], 'horse_surface':['horse_id','surface'],
 'horse_distance':['horse_id','distance_bucket'], 'horse_course':['horse_id','racecourse'],
 'jockey':['jockey_id'], 'trainer':['trainer_id'],
 'course_gate':['racecourse','surface','distance_bucket','gate'],
}
EXTRA_GROUPS = {
 'horse_wet':['horse_id','wet'], 'horse_jockey':['horse_id','jockey_id'],
 'horse_trainer':['horse_id','trainer_id'],
 'horse_course_distance':['horse_id','racecourse','distance_bucket'],
 'jockey_trainer':['jockey_id','trainer_id'],
 'jockey_course':['jockey_id','racecourse'], 'trainer_course':['trainer_id','racecourse'],
 'course_season':['racecourse','surface','distance_bucket','season'],
}

def dump(path, value):
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(value,ensure_ascii=False,indent=2,default=lambda x:x.item() if isinstance(x,np.generic) else str(x)))

def normalize(d, v):
 v=np.maximum(np.asarray(v,float),1e-12)
 return v / pd.Series(v).groupby(d.race_id.reset_index(drop=True),sort=False).transform('sum').to_numpy()

def periods(dates):
 return np.where(dates<'2025-07-01',PERIODS[0],np.where(dates<'2026-01-01',PERIODS[1],PERIODS[2]))

def cluster_stats(delta, dates, bootstrap=False):
 z=pd.DataFrame({'d':np.asarray(delta,float),'date':np.asarray(dates)}).groupby('date').d.agg(['sum','count'])
 n=int(z['count'].sum()); mean=float(z['sum'].sum()/n) if n else 0.
 if len(z)<20 or not n:return {'n':n,'delta':mean,'ci95':None,'p_one_sided':1.}
 residual=z['sum'].to_numpy()-mean*z['count'].to_numpy()
 se=float(np.sqrt(len(z)/(len(z)-1)*np.sum(residual**2))/n)
 p=float(norm.sf(mean/se)) if se else (0. if mean>0 else 1.)
 ci=[mean-1.96*se,mean+1.96*se]
 if bootstrap:
  rng=np.random.default_rng(20261018);a=z.to_numpy();idx=rng.integers(len(a),size=(2000,len(a)));s=a[idx].sum(axis=1)
  ci=np.quantile(s[:,0]/s[:,1],[.025,.975]).tolist()
 return {'n':n,'days':len(z),'delta':mean,'ci95':ci,'p_one_sided':p}

def by_adjust(p):
 """Benjamini-Yekutieli controls FDR even for overlapping conditions."""
 p=np.asarray(p,float);n=len(p)
 if not n:return []
 order=np.argsort(p);out=np.empty(n);factor=sum(1/i for i in range(1,n+1))
 out[order]=np.minimum(1,np.minimum.accumulate((p[order]*n*factor/np.arange(1,n+1))[::-1])[::-1])
 return out.tolist()

def raw_data(league):
 if league=='nar':
  from nar_live_model import normalize_courses
  d=normalize_courses(pd.read_parquet(ROOT/'research-input/12101739035/nar-history.parquet'))
 else:d=pd.read_parquet(next((ROOT/'.second-third-audit/jra').glob('*/data/history.parquet')))
 d['race_date']=pd.to_datetime(d.race_date).dt.strftime('%Y-%m-%d')
 d['race_id']=d.race_id.astype(str)
 return d.drop_duplicates(['race_id','horse_number'],keep='last').sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)

def enrich(d):
 d=d.copy();dt=pd.to_datetime(d.race_date)
 d['distance_bucket']=(pd.to_numeric(d.distance_m,errors='coerce')//200).fillna(-1).astype(int)
 d['distance_band']=np.where(d.distance_m<1400,'short',np.where(d.distance_m<=1800,'mile','long'))
 d['season']=((dt.dt.month%12)//3).astype(str)
 d['wet']=np.where(d.going.isin(['稍重','重','不良']),'wet','dry')
 d['field_size']=d.groupby('race_id').race_id.transform('size')
 d['field_band']=np.where(d.field_size<=8,'small',np.where(d.field_size<=12,'medium','large'))
 # Grade is deliberately conservative; unknown names are not inferred as graded.
 name=d.race_name.fillna('').astype(str)
 cls=d.get('race_class',pd.Series('',index=d.index)).fillna('').astype(str)
 d['grade']=np.where((name+' '+cls).str.contains(r'G[ⅠⅡⅢ123]|Jpn|重賞|Ｇ[１２３]|GI|GII|GIII',regex=True),'graded','other')
 for c in ['horse_id','jockey_id','trainer_id']:
  d[c]=d[c].fillna('').astype(str).str.replace(r'\.0$','',regex=True).str.lstrip('0')
 return d

def prior_features(d):
 """Date-batched counts: changing any outcome today/future cannot affect today."""
 work=d.copy()
 status=work.finish_status.fillna('').astype(str)
 work['_n']=(~status.str.contains('取消|除外')).astype(float)
 for k in (1,2,3):work[f'_r{k}']=work.finish_position.eq(k).astype(float)
 work['_top3']=work.finish_position.between(1,3).astype(float)
 cols=['_n','_r1','_r2','_r3','_top3'];out={}
 for name,keys in {**BASE_GROUPS,**EXTRA_GROUPS}.items():
  daily=work.groupby(keys+['race_date'],dropna=False,observed=True)[cols].sum().reset_index().sort_values('race_date')
  daily[cols]=daily.groupby(keys,dropna=False,observed=True)[cols].cumsum()-daily[cols]
  joined=work[keys+['race_date']].merge(daily,on=keys+['race_date'],how='left',sort=False,validate='many_to_one')
  n=joined._n.to_numpy();valid=np.ones(len(d),bool)
  for key in keys:
   if key.endswith('_id'):valid &= ~d[key].isin(['','0','nan','None','<NA>']).to_numpy()
  n=np.where(valid,n,0)
  out[f'{name}_n']=np.log1p(n).astype('float32')
  for c,prior in [('_r1',1.5),('_r2',1.5),('_r3',1.5),('_top3',4.5)]:
   out[f'{name}{c}']=((np.where(valid,joined[c],0)+prior)/(n+20)).astype('float32')
 f=pd.DataFrame(out,index=d.index)
 for c in ['racecourse','surface','going','sex','season','grade']:f[c]=d[c].fillna('unknown').astype('category')
 for c in ['distance_m','gate','horse_number','age','weight_carried','horse_weight','horse_weight_change','field_size']:
  f[c]=pd.to_numeric(d[c],errors='coerce').astype('float32')
 return f

def baseline_frame(league,raw):
 base=pd.read_parquet(ROOT/f'research-input/prepared/{league}-baseline.parquet')
 base['race_id']=base.race_id.astype(str)
 extras=[c for c in raw if c not in base]
 d=base.merge(raw[['race_id','horse_number']+extras],on=['race_id','horse_number'],how='left',validate='one_to_one')
 d=enrich(d)
 invalid=set(raw.loc[raw.finish_position.isna()|raw.finish_status.fillna('').astype(str).str.contains('取消|除外|中止|失格'),'race_id'])
 complete=raw.groupby('race_id').size();d['complete_field']=d.groupby('race_id').race_id.transform('size').eq(d.race_id.map(complete)) & ~d.race_id.isin(invalid)
 if league=='jra':
  m=d.racecourse.eq('阪神')&d.going.eq('良')&d.surface.isin(['芝','ダート'])&d.field_size.ge(6)&d.complete_field
  d.loc[m,'third']=(.75*normalize(d,d.third)+.25*normalize(d,d.second))[m]
 return d

def target_ranks(d,scores,target):
 r=pd.Series(scores,index=d.index).groupby(d.race_id,sort=False).rank(method='first',ascending=False)
 a=d.loc[d.finish_position.eq(target)]
 a=a.loc[a.groupby('race_id').race_id.transform('size').eq(1)]
 return r.loc[a.index].to_numpy(),a

def evaluate_predictions(d,preds,target):
 matrices=[];actual=None
 for values in preds.values():
  rr,actual=target_ranks(d,values,target);matrices.append(rr)
 rank=np.column_stack(matrices);names=list(preds);period=periods(actual.race_date.to_numpy());pop=actual.popularity.to_numpy()
 results={}
 for label in PERIODS:
  m=period==label;results[label]={}
  for j,name in enumerate(names):
   results[label][name]={'races':int(m.sum()),**{f'top{k}':float((rank[m,j]<=k).mean()) for k in (1,3,5)},'pop4_top5':float((rank[m&(pop>=4),j]<=5).mean()),'pop10_top5':float((rank[m&(pop>=10),j]<=5).mean())}
 sel=period==PERIODS[0];base=(rank[:,0]<=5)
 choices=[j for j in range(len(names)) if (rank[sel,j]<=5).sum()>=(rank[sel,0]<=5).sum() and (rank[sel&(pop>=4),j]<=5).sum()>=(rank[sel&(pop>=4),0]<=5).sum()]
 selected=max(choices,key=lambda j:((rank[sel,j]<=5).sum(),(rank[sel,j]<=3).sum(),j==0))
 comparisons={}
 for label in PERIODS:
  m=period==label;diff=(rank[:,selected]<=5).astype(int)-base.astype(int)
  comparisons[label]={cut:cluster_stats(diff[m&((pop>=threshold) if threshold else True)],actual.race_date.to_numpy()[m&((pop>=threshold) if threshold else True)],True) for cut,threshold in [('all',0),('pop4',4),('pop10',10)]}
 passed=selected!=0 and all(comparisons[p]['all']['ci95'] and comparisons[p]['all']['ci95'][0]>0 and comparisons[p]['pop4']['delta']>=0 and results[p][names[selected]]['top3']>=results[p]['current']['top3'] for p in PERIODS[1:])
 report={'selected':names[selected],'gate':'research_candidate' if passed else 'keep_current','candidates':results,'comparisons':comparisons}
 return report,actual,rank,names

def condition_search(actual,rank,names):
 """One candidate is chosen per condition using H1; audit never chooses a rule."""
 d=actual.reset_index(drop=True);period=periods(d.race_date.to_numpy());pop=d.popularity.to_numpy();h=(rank<=5).astype('int8');b=h[:,0]
 columns=['racecourse','surface','distance_band','going','field_band','season','grade']
 searched=0;selected=[]
 for depth in (1,2,3):
  for keys in itertools.combinations(columns,depth):
   for values,idx in d.groupby(list(keys),observed=True,sort=True).indices.items():
    idx=np.asarray(idx);s=idx[period[idx]==PERIODS[0]]
    if len(s)<100:continue
    searched+=(len(names)-1)
    outsider=s[pop[s]>=4]
    if len(outsider)<25:continue
    gain=(h[s]-b[s,None]).sum(axis=0)
    eligible=[j for j in range(1,len(names)) if gain[j]>0 and (h[outsider,j]-b[outsider]).sum()>=0]
    if not eligible:continue
    j=max(eligible,key=lambda q:(gain[q],(rank[s,q]<=3).sum(),-q))
    record={'keys':dict(zip(keys,values if isinstance(values,tuple) else (values,))),'candidate':names[j],'depth':depth,'periods':{}}
    for p in PERIODS:
     ii=idx[period[idx]==p];a=h[ii,j]-b[ii];z=cluster_stats(a,d.race_date.to_numpy()[ii]);z.update({'baseline_top5':float(b[ii].mean()) if len(ii) else None,'candidate_top5':float(h[ii,j].mean()) if len(ii) else None,'top3_delta':float(((rank[ii,j]<=3).astype(int)-(rank[ii,0]<=3).astype(int)).mean()) if len(ii) else None,'pop4_delta':float((h[ii[pop[ii]>=4],j]-b[ii[pop[ii]>=4]]).mean()) if (pop[ii]>=4).any() else None});record['periods'][p]=z
    selected.append(record)
 for p in PERIODS[1:]:
  q=by_adjust([r['periods'][p]['p_one_sided'] for r in selected])
  for r,value in zip(selected,q):r['periods'][p]['by_q']=value
 for r in selected:
  r['passed']=all(z['n']>=100 and z['by_q']<=.05 and z['delta']>0 and z['pop4_delta'] is not None and z['pop4_delta']>=0 and z['top3_delta']>=0 for z in [r['periods'][p] for p in PERIODS[1:]])
 return {'candidate_condition_tests_in_selection':searched,'selected_rules':len(selected),'passed':sum(r['passed'] for r in selected),'rules':selected}

def run_roles(league):
 import lightgbm as lgb
 print('LOAD',league,flush=True);raw=enrich(raw_data(league));d=baseline_frame(league,raw)
 fp=CACHE/f'{league}-interaction-features.parquet'
 if fp.exists():f=pd.read_parquet(fp)
 else:
  print('FEATURES',league,len(raw),flush=True);f=prior_features(raw);f.to_parquet(fp)
 # Feature row IDs are joined explicitly, never aligned by coincidental position.
 lookup=pd.MultiIndex.from_frame(raw[['race_id','horse_number']]);idx=lookup.get_indexer(pd.MultiIndex.from_frame(d[['race_id','horse_number']]))
 if (idx<0).any():raise ValueError('Missing raw feature row')
 f=f.iloc[idx].reset_index(drop=True)
 train=d.race_date.lt('2025-01-01')&d.surface.ne('ばんえい')
 ev=d.race_date.ge('2025-01-01')&d.complete_field&d.surface.ne('ばんえい')&d.field_size.ge(6)
 ed=d.loc[ev].reset_index(drop=True)
 report={'league':league,'raw_rows':len(raw),'raw_races':raw.race_id.nunique(),'raw_dates':[raw.race_date.min(),raw.race_date.max()],'training_rows':int(train.sum()),'evaluation_races':ed.race_id.nunique(),'evaluation_period_races':ed.groupby(periods(ed.race_date)).race_id.nunique().to_dict(),'features':list(f),'baseline':'current JRA including Hanshin supplement; NAR current recipe frozen at 2024-12-31','roles':{}}
 saved=ed[['race_id','horse_number','race_date','first','second','third']].copy()
 extra_prefix=tuple(f'{g}_' for g in EXTRA_GROUPS)
 # Prefixes use exact generated columns to avoid accidentally excluding base names.
 extra_cols={f'{g}{suffix}' for g in EXTRA_GROUPS for suffix in ['_n','_r1','_r2','_r3','_top3']}
 basecols=[c for c in f if c not in extra_cols]
 for target,role in enumerate(ROLES,1):
  base=normalize(ed,ed[role]);preds={'current':base}
  for config,cols in [('history',basecols),('interactions',list(f))]:
   modelpath=CACHE/f'{league}-{role}-{config}.txt';print('TRAIN',league,role,config,flush=True)
   if modelpath.exists():model=lgb.Booster(model_file=str(modelpath))
   else:
    fit=lgb.LGBMClassifier(n_estimators=160,num_leaves=15,min_child_samples=300,reg_lambda=15,learning_rate=.04,n_jobs=2,verbosity=-1,random_state=20261018,max_bin=63)
    fit.fit(f.loc[train,cols],d.loc[train,'finish_position'].eq(target).astype(int));model=fit.booster_;model.save_model(str(modelpath))
   value=normalize(ed,model.predict(f.loc[ev,cols],num_threads=2));preds[config]=value
   for w in [.1,.25,.5]:preds[f'{config}_mix{w}']=(1-w)*base+w*value
  for other in ROLES:
   if other==role:continue
   for w in [.1,.25,.5]:preds[f'{other}_support{w}']=(1-w)*base+w*normalize(ed,ed[other])
  for group in ['horse_jockey','jockey_trainer','horse_course_distance','horse_wet','jockey_course','trainer_course']:
   val=normalize(ed,f.loc[ev,f'{group}_r{target}'].to_numpy())
   for w in [.1,.25]:preds[f'{group}_prior{w}']=(1-w)*base+w*val
  result,actual,rank,names=evaluate_predictions(ed,preds,target)
  result['conditions']=condition_search(actual,rank,names);report['roles'][role]=result
  saved[f'{role}_selected']=preds[result['selected']]
  print('ROLE RESULT',league,role,result['selected'],result['gate'],'conditions passed',result['conditions']['passed'],flush=True)
  dump(OUT/f'{league}-roles.json',report)
 saved.to_parquet(CACHE/f'{league}-selected-scores.parquet')

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['roles']);parser.add_argument('--league',choices=['jra','nar'],required=True);args=parser.parse_args();run_roles(args.league)
