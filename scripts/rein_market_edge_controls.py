"""Matched-hyperparameter controls for the predeclared feature-family tests."""
import argparse,hashlib,json,sys
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb
from rein_market_edge_research import new_features,make_cohort,partition_features,probabilities,ROLES,SEED
from rein_blend_top5_audit import build_features

def main(a):
 root=Path(a.bundle_root);out=Path(a.output);out.mkdir(exist_ok=True,parents=True)
 repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'rein-web/api'))
 import rein_core as core
 mf=json.loads((root/'manifest.json').read_text())
 for item in mf['files']:
  assert hashlib.sha256((root/item['path']).read_bytes()).hexdigest()==item['sha256']
 x,f=build_features(pd.read_parquet(root/'data/history.parquet'),core)
 f,_=new_features(x,f,ROLES[a.role]);meta,f=make_cohort(x,f)
 tr=meta.race_date.lt('2025-01-01');ev=~tr;e=meta.loc[ev].reset_index(drop=True);ef=f.loc[ev].reset_index(drop=True)
 for c in f.select_dtypes('category').columns:
  cats=f.loc[tr,c].dropna().unique().tolist();f[c]=pd.Categorical(f[c],categories=cats);ef[c]=pd.Categorical(ef[c],categories=cats)
 codes,_=pd.factorize(e.race_id,sort=False);market,_=partition_features(list(f));y=meta.finish_numeric.eq(ROLES[a.role]).astype(int)
 result=e[['race_id','race_date','horse_number','popularity','finish_numeric','racecourse','surface']].copy()
 for name,cols in [('market_matched',market),('full_matched',list(f))]:
  m=lgb.LGBMClassifier(n_estimators=180,num_leaves=15,learning_rate=.035,min_child_samples=400,reg_lambda=15,feature_fraction=.85,verbosity=-1,n_jobs=2,random_state=SEED,max_bin=127)
  m.fit(f.loc[tr,cols],y.loc[tr]);result[name]=probabilities(m.predict_proba(ef[cols],num_threads=2)[:,1],codes)
  m.booster_.save_model(str(out/(a.role+'_'+name+'.txt')))
 result.to_csv(out/'controls.csv.gz',index=False,compression='gzip')
 (out/'protocol.json').write_text(json.dumps({'role':a.role,'fits':2,'trees':180,'leaves':15,'train_through':'2024-12-31','purpose':'matched controls, not outcome-selected'},indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--bundle-root',required=True);p.add_argument('--output',required=True);p.add_argument('--role',choices=ROLES,required=True);main(p.parse_args())
