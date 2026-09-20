"""Offline experiments; not the deployed REIN scoring engine."""
import json, re, sys
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from baken_academia.history_features import add_point_in_time_features
from baken_academia.features import build_feature_frame

OUT=Path('reports/rein-research-v2');OUT.mkdir(parents=True,exist_ok=True)
def prepare(raw):
    x=raw.copy();x['race_date']=pd.to_datetime(x.race_date)
    x=x.loc[~x.finish_status.astype(str).str.contains('取消|除外')].copy()
    x=x.sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)
    if x.duplicated(['horse_id','race_date']).any():raise ValueError('Multiple horse starts in a day require day-level history')
    x=add_point_in_time_features(x).sort_values(['horse_id','race_date']).reset_index(drop=True)
    seconds=x.finish_time.astype(str).str.extract(r'^(\d+):(\d+(?:\.\d+)?)$').astype(float)
    speed=x.distance_m/(seconds[0]*60+seconds[1])
    field=x.groupby('race_id').horse_id.transform('size')
    def corners(v):
        try:return [float(i) for i in json.loads(v) if str(i).isdigit()]
        except:return []
    c=x.corner_positions.map(corners)
    early=c.map(lambda a:a[0] if a else np.nan)/field
    late=c.map(lambda a:a[-1] if a else np.nan)/field
    def pace(v):
        try:
            a=json.loads(v);return sum(a[:3]) if len(a)>=3 else np.nan
        except:return np.nan
    signals={'speed':speed,'speed_relative':speed-speed.groupby(x.race_id).transform('median'),
             'early_pct':early,'late_pct':late,'position_gain':late-x.finish_position/field,
             'finish_pct':x.finish_position/field,'race_first3_laps':x.lap_times.map(pace),
             'past_popularity':x.popularity,'won':x.finish_position.eq(1).astype(float),
             'placed':x.finish_position.between(1,3).astype(float)}
    for name,s in signals.items():
        g=s.groupby(x.horse_id)
        x['prior_'+name]=g.shift(1)
        x['recent3_'+name]=g.transform(lambda a:a.shift(1).rolling(3,min_periods=1).mean())
    for key in ['jockey_id','trainer_id']:
        for target,s in [('win',signals['won']),('place',signals['placed'])]:
            d=pd.DataFrame({'entity':x[key].fillna('missing'),'date':x.race_date,'value':s})
            daily=d.groupby(['entity','date']).value.agg(['sum','count']).reset_index()
            pieces=[]
            for entity,g in daily.groupby('entity',sort=False):
                g=g.set_index('date').sort_index();rr=g[['sum','count']].rolling('90D',closed='left').sum()
                g['rate']=(rr['sum']+ (1.5 if target=='win' else 4.5))/(rr['count']+20)
                pieces.append(g.reset_index()[['entity','date','rate']])
            lookup=pd.concat(pieces).set_index(['entity','date']).rate
            x[key+'_recent90_'+target]=lookup.reindex(pd.MultiIndex.from_arrays([d.entity,d.date])).to_numpy()
    x['expected_front_count']=x.prior_early_pct.le(.25).groupby(x.race_id).transform('sum')
    x['relative_early']=x.prior_early_pct-x.groupby('race_id').prior_early_pct.transform('mean')
    return x.sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)

def metrics(x,score):
    r=x[['race_id','horse_id','horse_number','finish_position']].copy();r['score']=np.asarray(score)
    r=r.sort_values(['race_id','score','horse_number'],ascending=[True,False,True]);r['rank']=r.groupby('race_id').cumcount()+1
    rows=[]
    for k in [1,2,3]:
        z=r[r['rank']==k];rows.append({'rank':k,'n':len(z),'win':float(z.finish_position.eq(1).mean()),'top2':float(z.finish_position.between(1,2).mean()),'top3':float(z.finish_position.between(1,3).mean())})
    z=r[r['rank']<=3];g=z.assign(win=z.finish_position.eq(1),place=z.finish_position.between(1,3)).groupby('race_id').agg(winner=('win','any'),placed=('place','sum'))
    return {'by_rank':rows,'races':len(g),'winner_in_top3':float(g.winner.mean()),'two_placed':float(g.placed.ge(2).mean()),'three_placed':float(g.placed.eq(3).mean())},r

def main():
    raw=pd.read_parquet('data/raw/history.parquet');print('preparing',len(raw),flush=True)
    x=prepare(raw);base,_,cats=build_feature_frame(x)
    extra=[c for c in x if c.startswith(('prior_','recent3_')) or '_recent90_' in c]+['expected_front_count','relative_early']
    market=pd.DataFrame({'popularity':pd.to_numeric(x.popularity,errors='coerce'),'field_size':x.field_size})
    market['popularity_pct']=market.popularity/market.field_size
    frames={'market_only':market,'market_history':pd.concat([base,market[['popularity','popularity_pct']]],axis=1),'market_rich':pd.concat([base,market[['popularity','popularity_pct']],x[extra]],axis=1)}
    train=x.race_date.lt('2023-01-01');valid=x.race_date.between('2023-01-01','2023-12-31');audit=x.race_date.between('2024-01-01','2024-12-31');later=x.race_date.ge('2025-01-01')
    report={'scope':'Offline research, not production REIN; 2025-2026 previously inspected, retrospective only','data':{'rows':len(x),'races':x.race_id.nunique()},'experiments':{},'periods':{}}
    predictions={'popularity':-x.popularity.fillna(999).to_numpy()}
    for family,f in frames.items():
        for target in ['win','place']:
            y=x.finish_position.eq(1) if target=='win' else x.finish_position.between(1,3)
            name=family+'_'+target;print('training',name,flush=True)
            model=lgb.LGBMClassifier(n_estimators=600,learning_rate=.035,num_leaves=15,min_child_samples=200,reg_lambda=5,n_jobs=4,verbosity=-1,random_state=456)
            model.fit(f.loc[train],y.loc[train],eval_set=[(f.loc[valid],y.loc[valid])],callbacks=[lgb.early_stopping(50,verbose=False)])
            predictions[name]=model.predict_proba(f)[:,1]
            report['experiments'][name]={'iterations':model.best_iteration_,'features':list(f.columns)}
    for period,mask in [('validation_2023',valid),('audit_2024',audit),('retrospective_2025_2026',later)]:
        report['periods'][period]={}
        for name,p in predictions.items():
            m,r=metrics(x.loc[mask],p[mask]);report['periods'][period][name]=m
            if period=='retrospective_2025_2026':r.to_csv(OUT/(name+'.csv.gz'),index=False)
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=int))
    print(json.dumps(report['periods'],ensure_ascii=False),flush=True)
if __name__=='__main__':main()
