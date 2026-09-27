"""Exploratory feature-family audit. Never edits production scores.

Point-in-time features, frozen pre-2025 base model predictions. Fit fixed-strength
logistic residuals on 2025 H1, confirm H2, audit already inspected 2026. Final
historical popularity is diagnostic, not evidence of live cutoff performance.
"""
from __future__ import annotations
import argparse, hashlib, json, sys, warnings
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.special import expit, logit
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression

def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    root=Path(a.workspace);out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'rein-web/api'))
    import rein_core as core
    from feature_roadmap_helpers import build_features, add_context_jockey_features, make_cohort
    warnings.filterwarnings('ignore',category=pd.errors.PerformanceWarning)
    history_path=next((root/'model_bundle').glob('*/data/history.parquet'))
    raw=pd.read_parquet(history_path)
    print('Building point-in-time features',flush=True)
    meta,features=build_features(raw,core)
    features,_=add_context_jockey_features(meta,features)
    # Last race opposition: opponents' pre-race top3 records, then shifted to the
    # horse's next start. Never use future wins of past opponents.
    rates=features.horse_top3_rate
    quality=(rates.groupby(meta.race_id).transform('sum')-rates)/(rates.groupby(meta.race_id).transform('size')-1).replace(0,np.nan)
    features['previous_opposition']=quality.groupby(meta.horse_id).shift(1)
    # Intraday bias uses ONLY earlier race numbers at the same venue and surface.
    z=meta[['race_id','race_date','racecourse','surface','race_no','finish_numeric']].copy()
    z['front']=features.prior_early_pct.le(.25).astype(float);z['gate_pct']=features.gate_pct
    races=z.groupby('race_id',sort=False).agg(date=('race_date','first'),venue=('racecourse','first'),surface=('surface','first'),no=('race_no','first'),front_share=('front','mean'),gate_mean=('gate_pct','mean'))
    winner=z[z.finish_numeric.eq(1)].drop_duplicates('race_id').set_index('race_id')
    races['front_surprise']=winner.front-races.front_share;races['gate_surprise']=winner.gate_pct-races.gate_mean
    races=races.sort_values(['date','venue','surface','no']);keys=['date','venue','surface']
    g=races.groupby(keys);n=g.cumcount()
    for col in ['front_surprise','gate_surprise']:
        prior=(g[col].cumsum()-races[col])/(n+8)
        features['day_'+col]=meta.race_id.map(prior).to_numpy()
    features['day_front_interaction']=features.day_front_surprise*(.5-features.prior_early_pct)
    features['day_gate_interaction']=features.day_gate_surprise*(features.gate_pct-.5)
    coverage={c:float(raw[c].notna().mean()) for c in raw.columns}
    coverage['lap_times_nonempty']=float(raw.lap_times.fillna('[]').ne('[]').mean())
    coverage['corner_positions_nonempty']=float(raw.corner_positions.fillna('[]').ne('[]').mean())
    meta,features=make_cohort(meta,features)
    frozen=pd.read_csv(root/'analysis_input/frozen_predictions.csv.gz')
    lookup=meta[['race_id','horse_number']].copy();lookup['row']=np.arange(len(meta))
    frozen=frozen.merge(lookup,on=['race_id','horse_number'],validate='one_to_one').sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)
    rows=frozen.row.to_numpy();f=features.iloc[rows].reset_index(drop=True);m=meta.iloc[rows].reset_index(drop=True)
    codes,ids=pd.factorize(frozen.race_id,sort=False);groups=[np.flatnonzero(codes==i) for i in range(len(ids))]
    dates=pd.to_datetime(frozen.race_date);train=dates<'2025-07-01'
    race_dates=np.array([str(dates.iloc[ix[0]].date()) for ix in groups])
    masks={'2025H2':(race_dates>='2025-07-01')&(race_dates<'2026-01-01'),'2026':race_dates>='2026-01-01'}
    families={
      'condition_change':['distance_change_m','same_surface_as_last','same_course_as_last','horse_surface_top3_rate','horse_distance_top3_rate','horse_course_top3_rate','horse_wet_prior_top3_rate','class_change'],
      'pace_scenario':['prior_early_pct','prior_late_pct','front_pressure_share','front_under_pressure','closer_pressure_help','known_style_share','distance_change_m'],
      'body_rest':['horse_weight_change','days_since_last_start','horse_weight_vs_field','weight_carried_vs_field'],
      'ability_parts':['recent3_speed_relative','recent3_closing3f_z','recent3_position_gain','relative_early','relative_late'],
      'jockey_conditions':[c for c in f if c.startswith(('jockey_course_', 'jockey_distance_', 'jockey_going_', 'jockey_id_recent90'))],
      'past_opposition':['previous_opposition','recent3_result_strength','class_change'],
      'same_day_bias':['day_front_surprise','day_gate_surprise','day_front_interaction','day_gate_interaction'],
    }
    families['jockey_conditions']=[c for c in families['jockey_conditions'] if pd.api.types.is_numeric_dtype(f[c])]
    report={'protocol':'Exploratory fixed residual ridge penalty 20; fit 2025H1 on frozen <=2024 models; confirm 2025H2; audit previously inspected 2026. Reference is historical vectorized model calculation, not bit-identical to current serving. No live-cutoff or production improvement claim.','training_races':int(frozen.loc[train,'race_id'].nunique()),'coverage':coverage,'families':{},'popular_bands':[],'market_reference':{}}
    report['provenance']={'history_sha256':hashlib.sha256(history_path.read_bytes()).hexdigest(),'frozen_predictions_sha256':hashlib.sha256((root/'analysis_input/frozen_predictions.csv.gz').read_bytes()).hexdigest(),'history_rows':len(raw),'cohort_races':len(groups),'through':str(dates.max().date())}
    pop=frozen.popularity.to_numpy();finish=frozen.finish_numeric.to_numpy();number=frozen.horse_number.to_numpy()
    rng=np.random.default_rng(20260927)
    def hit(prob,target):
        return np.array([target in finish[ix[np.lexsort((number[ix],-prob[ix]))][:5]] for ix in groups])
    def diff_ci(c,b,mask):
        selected_dates=race_dates[mask];_,day=np.unique(selected_dates,return_inverse=True)
        den=np.bincount(day);num=np.bincount(day,weights=(c.astype(float)-b.astype(float))[mask]);draw=rng.integers(len(den),size=(1500,len(den)))
        return (100*np.quantile(num[draw].sum(1)/den[draw].sum(1),[.025,.975])).tolist()
    for family,cols in families.items():
        print('Auditing',family,len(cols),flush=True)
        imp=SimpleImputer(strategy='median',keep_empty_features=True);sc=StandardScaler()
        x=imp.fit_transform(f.loc[train,cols]);x=sc.fit_transform(x)
        allx=np.clip(sc.transform(imp.transform(f[cols])),-5,5);x=allx[train]
        result={'features':cols,'roles':{}}
        for target,role in enumerate(['first','second','third'],1):
            base=frozen['p_'+role].to_numpy();offset=logit(np.clip(base,1e-7,1-1e-7));y=(finish==target).astype(float);yy=y[train];oo=offset[train]
            def objective(beta):
                a=oo+x@beta
                return np.logaddexp(0,a).sum()-yy@a+10*(beta@beta), x.T@(expit(a)-yy)+20*beta
            fit=minimize(objective,np.zeros(x.shape[1]),jac=True,method='L-BFGS-B',options={'maxiter':100})
            pred=expit(offset+allx@fit.x);pred/=np.bincount(codes,weights=pred)[codes]
            bh=hit(base,target);ch=hit(pred,target);tp=np.array([pop[ix[finish[ix]==target][0]] for ix in groups])
            rr={}
            for period,mask in masks.items():
                rr[period]={}
                for band,threshold in [('all',1),('4plus',4),('6plus',6),('10plus',10)]:
                    sel=mask&(tp>=threshold)
                    rr[period][band]={'races':int(sel.sum()),'base_top5':float(bh[sel].mean()),'candidate_top5':float(ch[sel].mean()),'delta_pp':float(100*(ch[sel].mean()-bh[sel].mean())),'ci95_pp':diff_ci(ch,bh,sel)}
            result['roles'][role]=rr
        report['families'][family]=result
    # Popularity-band event calibration: one or more horses in a band in top3.
    # Sum of individual top3 probabilities is never treated as event probability.
    mf=pd.read_parquet(root/'market_model_artifact/first/predictions.parquet')
    q=frozen[['race_id','horse_number','popularity','finish_numeric']].merge(mf[['race_id','horse_number','real_odds_market','real_odds_plus_all']],on=['race_id','horse_number'],validate='one_to_one')
    race_rows=[]
    for rid,r in q.groupby('race_id',sort=False):
        row={'race_id':rid,'field':len(r),'max_market':r.real_odds_market.max(),'market_concentration':float((r.real_odds_market**2).sum())}
        for name,lo,hi in [('1to3',1,3),('4to6',4,6),('7to9',7,9),('10plus',10,99)]:
            b=r[r.popularity.between(lo,hi)];row[name+'_count']=len(b);row[name+'_market']=b.real_odds_market.sum();row[name+'_rein']=b.real_odds_plus_all.sum();row[name+'_win']=int(b.finish_numeric.eq(1).any());row[name+'_top3']=int(b.finish_numeric.le(3).any())
        race_rows.append(row)
    rb=pd.DataFrame(race_rows).set_index('race_id').reindex(ids).reset_index();rt=race_dates<'2025-07-01'
    cols=list(dict.fromkeys([c for c in rb if c.endswith(('_market','_rein','_count'))]+['field','max_market','market_concentration']))
    x=StandardScaler().fit(rb.loc[rt,cols]);xx=x.transform(rb[cols])
    for band in ['1to3','4to6','7to9','10plus']:
        for event in ['win','top3']:
            y=rb[band+'_'+event].to_numpy();fit=LogisticRegression(C=.2,max_iter=300).fit(xx[rt],y[rt]);pred=fit.predict_proba(xx)[:,1]
            baseline=rb.loc[rt].groupby('field')[band+'_'+event].mean();base=rb.field.map(baseline).fillna(y[rt].mean()).to_numpy()
            for period,mask in masks.items():
                mask=mask & rb[band+'_count'].gt(0).to_numpy()
                report['popular_bands'].append({'band':band,'event':event,'period':period,'races':int(mask.sum()),'base_brier':float(np.mean((base[mask]-y[mask])**2)),'model_brier':float(np.mean((pred[mask]-y[mask])**2)),'predicted_mean':float(pred[mask].mean()),'observed':float(y[mask].mean())})
    # Existing market-difference reference, descriptive diagnostics only.
    q['date']=pd.to_datetime(q.race_id.str[:8],format='%Y%m%d');q['ratio']=q.real_odds_plus_all/q.real_odds_market
    for year in [2025,2026]:
        d=q[(q.date.dt.year==year)&q.popularity.ge(4)];higher=d[d.ratio>1]
        report['market_reference'][str(year)]={'all_outsiders':len(d),'higher_than_market':len(higher),'all_win_rate':float(d.finish_numeric.eq(1).mean()),'higher_win_rate':float(higher.finish_numeric.eq(1).mean()),'all_top3_rate':float(d.finish_numeric.le(3).mean()),'higher_top3_rate':float(higher.finish_numeric.le(3).mean())}
    parity_path=out/'runtime-parity.json'
    report['runtime_parity']={'status':'not_bit_identical; adoption blocked pending reconciliation','sample_file':parity_path.name,'sample':json.loads(parity_path.read_text()) if parity_path.exists() else [],'note':'Batch feature parity tolerances can pass while tree predictions differ near numerical split boundaries; missing jockey identifiers also differ. Do not label these figures as exact production hit rates.'}
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'report':str(out/'report.json'),'families':list(families),'races':len(groups)},ensure_ascii=False),flush=True)

if __name__=='__main__': main()
