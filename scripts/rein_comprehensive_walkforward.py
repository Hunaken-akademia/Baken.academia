"""Older-year temporal robustness check of the fixed NAR first-place candidate.
Candidate definition was chosen after inspecting 2025: older years are a
retrospective stress test, not independent model selection evidence.
"""
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from rein_comprehensive_validation import ROOT,CACHE,OUT,raw_data,enrich,baseline_frame,normalize,target_ranks,cluster_stats,dump
from nar_live_model import prior_features,inputs_by_mode
from nar_condition_validation import fit,predict

def run():
 from nar_live_model import normalize_courses
 cols=['race_id','race_date','race_name','racecourse','baba_code','surface','going','distance_m','horse_id','jockey_id','trainer_id','gate','horse_number','sex','age','weight_carried','horse_weight','horse_weight_change','finish_status','finish_position','popularity']
 raw=normalize_courses(pd.read_parquet(ROOT/'research-input/12101739035/nar-history.parquet',columns=cols));raw['race_date']=pd.to_datetime(raw.race_date).dt.strftime('%Y-%m-%d');raw['race_id']=raw.race_id.astype(str)
 raw=enrich(raw.drop_duplicates(['race_id','horse_number'],keep='last').sort_values(['race_date','race_id','horse_number']).reset_index(drop=True))
 invalid=set(raw.loc[raw.finish_position.isna()|raw.finish_status.fillna('').astype(str).str.contains('取消|除外|中止|失格'),'race_id'])
 d=raw.loc[raw.finish_position.notna()].copy().reset_index(drop=True);d['complete_field']=~d.race_id.isin(invalid)
 idx=pd.MultiIndex.from_frame(raw[['race_id','horse_number']]).get_indexer(pd.MultiIndex.from_frame(d[['race_id','horse_number']]))
 try: f=pd.read_parquet(CACHE/'nar-interaction-features.parquet')
 except Exception:
  from rein_comprehensive_validation import prior_features as interaction_features
  print('REBUILD INTERACTION CACHE',flush=True);f=interaction_features(raw)
  temp=CACHE/'nar-interaction-features.tmp.parquet';f.to_parquet(temp,compression='zstd');temp.replace(CACHE/'nar-interaction-features.parquet')
 f=f.iloc[idx].reset_index(drop=True)
 del raw
 print('WALK FEATURES READY',len(d),flush=True)
 x=inputs_by_mode(prior_features(d),d.race_id)['hybrid']
 result_path=OUT/'nar-walkforward.json'
 results=json.loads(result_path.read_text())['results'] if result_path.exists() else []
 for year in [2022,2023,2024]:
  if any(r['year']==year for r in results):continue
  train=d.race_date.lt(f'{year}-01-01').to_numpy();ev=d.race_date.between(f'{year}-01-01',f'{year}-12-31')&d.complete_field&d.surface.ne('ばんえい')&d.field_size.ge(6);ed=d.loc[ev].reset_index(drop=True)
  print('WALK FORWARD',year,'train',train.sum(),'audit',ed.race_id.nunique(),flush=True)
  baseline=fit(x[train],d.finish_position.eq(1).to_numpy()[train]);base=1/(1+np.exp(-np.clip(predict(baseline,x[ev]),-40,40)));base=normalize(ed,base)
  model=lgb.LGBMClassifier(n_estimators=160,num_leaves=15,min_child_samples=300,reg_lambda=15,learning_rate=.04,n_jobs=2,verbosity=-1,random_state=20261018,max_bin=63)
  model.fit(f.loc[train&d.surface.ne('ばんえい'),:],d.loc[train&d.surface.ne('ばんえい'),'finish_position'].eq(1).astype(int));candidate=normalize(ed,model.predict_proba(f.loc[ev])[:,1]);proposed=.5*base+.5*candidate
  br,a=target_ranks(ed,base,1);nr,_=target_ranks(ed,proposed,1);record={'year':year,'races':len(a),'training_end':f'{year-1}-12-31','metrics':{}}
  for label,cut in [('all',0),('pop4',4),('pop10',10)]:
   m=np.ones(len(a),bool) if cut==0 else a.popularity.ge(cut).to_numpy();z=cluster_stats((nr[m]<=5).astype(int)-(br[m]<=5).astype(int),a.race_date.to_numpy()[m],True)
   z['baseline_top5']=float((br[m]<=5).mean());z['candidate_top5']=float((nr[m]<=5).mean());z['top3_delta']=float(((nr[m]<=3).astype(int)-(br[m]<=3).astype(int)).mean());record['metrics'][label]=z
  results.append(record);dump(OUT/'nar-walkforward.json',{'kind':'retrospective older-year stress test; recipe was selected using later 2025 results','fixed_candidate':'0.5 current history-hybrid + 0.5 new interaction model; no year-specific tuning','results':results});print('WALK RESULT',record,flush=True)
if __name__=='__main__':run()
