"""Additional temporal-form ablation; no outcomes on the race day are inputs."""
import argparse
import numpy as np
import pandas as pd
import lightgbm as lgb
from rein_comprehensive_validation import ROOT,OUT,CACHE,ROLES,enrich,normalize,raw_data,baseline_frame,evaluate_predictions,condition_search,dump

def recent_features(d):
 w=d[['horse_id','jockey_id','trainer_id','race_date','distance_m','horse_weight','finish_position','field_size','finish_status']].copy();w['date']=pd.to_datetime(w.race_date);w['relative_finish']=w.finish_position/w.field_size
 w['top3']=w.finish_position.between(1,3).astype(float);w['win']=w.finish_position.eq(1).astype(float);w['n']=(~w.finish_status.fillna('').astype(str).str.contains('取消|除外')).astype(float)
 out={}
 day=w.groupby(['horse_id','date'],observed=True).agg(relative_finish=('relative_finish','mean'),top3=('top3','mean'),distance_m=('distance_m','mean'),horse_weight=('horse_weight','mean')).reset_index().sort_values(['horse_id','date'])
 group=day.groupby('horse_id',sort=False)
 day['prev_date']=group.date.shift();day['prev_distance']=group.distance_m.shift();day['prev_weight']=group.horse_weight.shift();day['last_finish']=group.relative_finish.shift()
 for window in [3,5]:
  day[f'last{window}_finish']=day.groupby('horse_id',sort=False).relative_finish.transform(lambda x:x.shift().rolling(window,min_periods=1).mean())
  day[f'last{window}_top3']=day.groupby('horse_id',sort=False).top3.transform(lambda x:x.shift().rolling(window,min_periods=1).mean())
 cols=['prev_date','prev_distance','prev_weight','last_finish','last3_finish','last3_top3','last5_finish','last5_top3']
 joined=w[['horse_id','date']].merge(day[['horse_id','date']+cols],on=['horse_id','date'],how='left',sort=False,validate='many_to_one')
 out['recent_layoff_days']=(w.date-joined.prev_date).dt.days.astype('float32')
 out['recent_distance_change']=(w.distance_m-joined.prev_distance).astype('float32');out['recent_weight_change']=(w.horse_weight-joined.prev_weight).astype('float32')
 for c in cols[3:]:out['recent_'+c]=joined[c].astype('float32')
 for entity in ['jockey_id','trainer_id']:
  daily=w.groupby([entity,'date'],observed=True)[['n','win','top3']].sum().reset_index().sort_values('date')
  cumulative=daily.groupby(entity,sort=False)[['n','win','top3']].cumsum();prior=cumulative-daily[['n','win','top3']]
  table=daily[[entity,'date']].copy();table[['n','win','top3']]=cumulative
  full=daily[[entity,'date']].copy();full[['n','win','top3']]=prior
  for window in [90,365]:
   left=daily[[entity,'date']].copy();left['date']=left.date-pd.Timedelta(days=window)
   old=pd.merge_asof(left,table,on='date',by=entity,allow_exact_matches=False).fillna({'n':0,'win':0,'top3':0})
   values=prior.to_numpy()-old[['n','win','top3']].to_numpy();result=daily[[entity,'date']].copy();result[['n','win','top3']]=values
   joined=w[[entity,'date']].merge(result,on=[entity,'date'],how='left',sort=False,validate='many_to_one');n=joined.n.to_numpy();valid=~w[entity].isin(['','0','nan','None','<NA>']).to_numpy();n=np.where(valid,n,0)
   out[f'recent_{entity}_{window}_n']=np.log1p(n).astype('float32')
   out[f'recent_{entity}_{window}_win']=((np.where(valid,joined.win,0)+1.5)/(n+20)).astype('float32')
   out[f'recent_{entity}_{window}_top3']=((np.where(valid,joined.top3,0)+4.5)/(n+20)).astype('float32')
 f=pd.DataFrame(out)
 invalid=d.horse_id.isin(['','0','nan','None','<NA>'])
 f.loc[invalid,[c for c in f if not ('jockey_id' in c or 'trainer_id' in c)]]=np.nan
 return f

def run(league):
 if league=='nar':
  from nar_live_model import normalize_courses
  cols=['race_id','race_date','race_name','racecourse','baba_code','surface','going','distance_m','horse_id','jockey_id','trainer_id','gate','horse_number','sex','age','weight_carried','horse_weight','horse_weight_change','finish_status','finish_position','popularity']
  raw=normalize_courses(pd.read_parquet(ROOT/'research-input/12101739035/nar-history.parquet',columns=cols));raw['race_date']=pd.to_datetime(raw.race_date).dt.strftime('%Y-%m-%d');raw['race_id']=raw.race_id.astype(str)
  raw=enrich(raw.drop_duplicates(['race_id','horse_number'],keep='last').sort_values(['race_date','race_id','horse_number']).reset_index(drop=True))
  base=pd.read_parquet(ROOT/'research-input/prepared/nar-baseline.parquet',columns=['race_id','horse_number']+ROLES);d=base.merge(raw,on=['race_id','horse_number'],validate='one_to_one')
  invalid=set(raw.loc[raw.finish_position.isna()|raw.finish_status.fillna('').astype(str).str.contains('取消|除外|中止|失格'),'race_id']);d['complete_field']=~d.race_id.isin(invalid)
 else:
  raw=enrich(raw_data(league));d=baseline_frame(league,raw)
 fp=CACHE/f'{league}-recent-features.parquet'
 print('RECENT FEATURES',league,flush=True)
 if fp.exists():recent=pd.read_parquet(fp)
 else:
  recent=recent_features(raw);recent.to_parquet(fp,compression='zstd')
 idx=pd.MultiIndex.from_frame(raw[['race_id','horse_number']]).get_indexer(pd.MultiIndex.from_frame(d[['race_id','horse_number']]))
 f=pd.read_parquet(CACHE/f'{league}-interaction-features.parquet').iloc[idx].reset_index(drop=True);recent=recent.iloc[idx].reset_index(drop=True);f=pd.concat([f,recent],axis=1);del raw,recent
 train=d.race_date.lt('2025-01-01')&d.surface.ne('ばんえい');ev=d.race_date.ge('2025-01-01')&d.complete_field&d.surface.ne('ばんえい')&d.field_size.ge(6);ed=d.loc[ev].reset_index(drop=True)
 report={'league':league,'additional_features':[c for c in f if c.startswith('recent_')],'kind':'additional retrospective ablation; 2025H1 selects, H2 confirms, 2026 previously inspected','roles':{}}
 saved=ed[['race_id','horse_number','race_date']].copy()
 for target,role in enumerate(ROLES,1):
  print('RECENT TRAIN',league,role,flush=True);path=CACHE/f'{league}-{role}-recent.txt'
  if path.exists():model=lgb.Booster(model_file=str(path))
  else:
   fit=lgb.LGBMClassifier(n_estimators=160,num_leaves=15,min_child_samples=300,reg_lambda=15,learning_rate=.04,n_jobs=2,verbosity=-1,random_state=20261018,max_bin=63);fit.fit(f.loc[train],d.loc[train,'finish_position'].eq(target).astype(int));model=fit.booster_;model.save_model(str(path))
  base=normalize(ed,ed[role]);value=normalize(ed,model.predict(f.loc[ev],num_threads=2));preds={'current':base,'recent_interactions':value}
  for weight in [.1,.25,.5]:preds[f'recent_mix{weight}']=(1-weight)*base+weight*value
  result,actual,rank,names=evaluate_predictions(ed,preds,target);result['conditions']=condition_search(actual,rank,names);report['roles'][role]=result;saved[role+'_selected']=preds[result['selected']];dump(OUT/f'{league}-recent.json',report);print('RECENT RESULT',league,role,result['selected'],result['gate'],flush=True)
 saved.to_parquet(CACHE/f'{league}-recent-selected-scores.parquet')
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--league',choices=['jra','nar'],required=True);run(parser.parse_args().league)
