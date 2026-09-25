"""Read-only audit of frozen production REIN scores. No fitting or activation.
Primary cohort: JRA flat races with >5 actual starters, complete popularity,
unique finishers at positions 1,2,3. Select weights on 2025 only.
2026 is retrospective, not virgin holdout (models were audited before).
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
import numpy as np
import pandas as pd

MARKET_GRID = list(range(0, 101, 5))
ROLES = ('first', 'second', 'third')
BASE_MARKET = {'overall': 70, 'first': 0, 'second': 0, 'third': 0, 'overall_raw': 70}

def log(s):
    print(time.strftime('%H:%M:%S'), s, flush=True)

def numeric(s):
    return pd.to_numeric(s, errors='coerce').astype(float)

def prior_rates(x, keys, prefix):
    """Historical rows strictly before the race day, including entity ties."""
    d = x.groupby(keys + ['race_date'], observed=True, dropna=False).agg(
        n=('finish_numeric', 'count'), wins=('won', 'sum'), places=('placed', 'sum'),
        total_finish=('finish_numeric', 'sum')).reset_index()
    d = d.sort_values(keys + ['race_date']).reset_index(drop=True)
    cols = ['n', 'wins', 'places', 'total_finish']
    prior = d.groupby(keys, observed=True, dropna=False)[cols].cumsum() - d[cols]
    d[f'{prefix}_starts'] = prior.n
    d[f'{prefix}_win_rate'] = (prior.wins + 1.5) / (prior.n + 20)
    d[f'{prefix}_top3_rate'] = (prior.places + 4.5) / (prior.n + 20)
    d[f'{prefix}_avg_finish'] = prior.total_finish / prior.n.replace(0, np.nan)
    outcols = [f'{prefix}_{c}' for c in ('starts','win_rate','top3_rate','avg_finish')]
    return x[keys + ['race_date']].merge(d[keys + ['race_date'] + outcols],
        on=keys+['race_date'], how='left', sort=False, validate='many_to_one')[outcols]

def prior_90(x, key):
    d = x.groupby([key, 'race_date'], observed=True, dropna=False).agg(
        n=('horse_id','size'), wins=('won','sum'), places=('placed','sum')).reset_index()
    d = d.sort_values([key,'race_date']).reset_index(drop=True)
    totals = np.zeros((len(d),3))
    for _, idx in d.groupby(key, observed=True, sort=False).indices.items():
        idx = np.asarray(idx)
        sub = d.iloc[idx]
        dates = sub.race_date.to_numpy(dtype='datetime64[D]')
        left = np.searchsorted(dates, dates-np.timedelta64(90,'D'), side='left')
        c = np.vstack([np.zeros((1,3)),np.cumsum(sub[['n','wins','places']].to_numpy(float),axis=0)])
        totals[idx] = c[np.arange(len(idx))] - c[left]
    d[f'{key}_recent90_win'] = (totals[:,1]+1.5)/(totals[:,0]+20)
    d[f'{key}_recent90_place'] = (totals[:,2]+4.5)/(totals[:,0]+20)
    cols = [f'{key}_recent90_win',f'{key}_recent90_place']
    return x[[key,'race_date']].merge(d[[key,'race_date']+cols],on=[key,'race_date'],
        how='left',sort=False,validate='many_to_one')[cols]

def build_features(raw, core):
    """Vectorized deployed _feature_frame_full, checked against original."""
    x = core.prepare_inference_history(raw)
    x = x.sort_values(['horse_id','race_date','race_id','horse_number'],kind='stable').reset_index(drop=True)
    x['finish_numeric'] = numeric(x.finish_position)
    x['wet_key'] = x.going.isin(['重','不良'])
    n = len(x); idx = np.arange(n)
    horse_new = x.horse_id.ne(x.horse_id.shift()).to_numpy()
    group_start = np.maximum.accumulate(np.where(horse_new,idx,0))
    day_new = horse_new | x.race_date.ne(x.race_date.shift()).to_numpy()
    stop = np.maximum.accumulate(np.where(day_new,idx,0))
    have_prior = stop > group_start
    previous = np.maximum(stop-1,0)
    def prior(values):
        a = numeric(values).to_numpy()
        return np.where(have_prior, a[previous], np.nan)
    def mean(values, window):
        a = numeric(values).to_numpy(); valid = ~np.isnan(a)
        c = np.r_[0.0,np.cumsum(np.where(valid,a,0.0))]
        cnt = np.r_[0,np.cumsum(valid)]
        start = np.maximum(group_start,stop-window)
        total=c[stop]-c[start]; count=cnt[stop]-cnt[start]
        return np.divide(total,count,out=np.full(n,np.nan),where=count>0)
    f = pd.DataFrame(index=x.index)
    for col in core.CATEGORICAL: f[col] = x[col]
    for col in ('distance_m','horse_number','gate'): f[col] = numeric(x[col])
    for col in ('age','weight_carried','horse_weight'): f[col] = numeric(x[col]).replace(0,np.nan)
    f['horse_weight_change'] = numeric(x.horse_weight_change)
    field = x.groupby('race_id',observed=True).horse_id.transform('size').astype(float)
    f['field_size'] = field
    f['horse_number_pct'] = f.horse_number / field
    f['gate_pct'] = f.gate / f.gate.groupby(x.race_id,observed=True).transform('max').clip(lower=1)
    f['weight_carried_vs_field'] = f.weight_carried - f.weight_carried.groupby(x.race_id,observed=True).transform('mean')
    f['horse_weight_vs_field'] = f.horse_weight - f.horse_weight.groupby(x.race_id,observed=True).transform('mean')
    for keys,prefix in [(['horse_id'],'horse'),(['jockey_id'],'jockey'),(['trainer_id'],'trainer'),
        (['horse_id','surface'],'horse_surface'),(['horse_id','distance_bucket'],'horse_distance'),
        (['horse_id','racecourse'],'horse_course')]:
        f = pd.concat([f,prior_rates(x,keys,prefix)],axis=1)
    wet = prior_rates(x,['horse_id','wet_key'],'horse_wet_prior')
    f['horse_wet_prior_starts'] = wet.horse_wet_prior_starts
    f['horse_wet_prior_top3_rate'] = wet.horse_wet_prior_top3_rate
    days=x.race_date.to_numpy(dtype='datetime64[D]').astype('int64')
    f['days_since_last_start'] = np.where(have_prior,days-days[previous],np.nan)
    f['distance_change_m'] = f.distance_m-prior(x.distance_m)
    f['same_surface_as_last'] = np.where(have_prior,x.surface.to_numpy()==x.surface.to_numpy()[previous],False).astype(float)
    f['same_course_as_last'] = np.where(have_prior,x.racecourse.to_numpy()==x.racecourse.to_numpy()[previous],False).astype(float)
    f['horse_recent5_avg_finish'] = mean(x.finish_numeric,5)
    f['horse_recent5_win_rate'] = mean(x.won,5)
    f['horse_recent5_top3_rate'] = mean(x.placed,5)
    for position in (1,2,3):
        for w in (5,10):
            f[f'history_exact_{position}_last{w}'] = mean(x.finish_numeric.eq(position).astype(float),w)
    for signal in core.SIGNALS:
        f[f'prior_{signal}'] = prior(x[signal])
        f[f'recent3_{signal}'] = mean(x[signal],3)
    for key in ('jockey_id','trainer_id'): f = pd.concat([f,prior_90(x,key)],axis=1)
    f['class_tier'] = x.race_class.map(core.CLASS_TIER).astype(float)
    f['prior_class_tier'] = prior(x.class_tier_result)
    f['class_change'] = f.class_tier-f.prior_class_tier
    f['class_rise'] = f.class_change.clip(lower=0)
    f['class_drop'] = (-f.class_change).clip(lower=0)
    ct=x.class_tier_result.to_numpy(float); recentmax=np.full(n,np.nan)
    for j in range(1,6):
        valid=stop-j>=group_start
        candidate=np.where(valid,ct[np.maximum(stop-j,0)],np.nan)
        recentmax=np.fmax(recentmax,candidate)
    f['recent5_max_class']=recentmax
    f['class_vs_recent_max']=f.class_tier-f.recent5_max_class
    f['prior_distance_m']=prior(x.distance_m)
    f['recent3_distance_m']=mean(x.distance_m,3)
    f['distance_abs_change']=(f.distance_m-f.prior_distance_m).abs()
    f['stretching_out']=(f.distance_m-f.prior_distance_m).clip(lower=0)
    f['shortening']=(f.prior_distance_m-f.distance_m).clip(lower=0)
    f['distance_vs_recent3']=f.distance_m-f.recent3_distance_m
    for signal in ('closing3f_relative','closing3f_z'):
        f[f'prior_{signal}']=prior(x[signal])
        for w in (3,5): f[f'recent{w}_{signal}']=mean(x[signal],w)
    f['recent3_result_strength']=mean(x.result_strength,3)
    early=f.prior_early_pct
    f['expected_front_count']=early.le(.25).groupby(x.race_id,observed=True).transform('sum').astype(float)
    f['relative_early']=early-early.groupby(x.race_id,observed=True).transform('mean')
    f['front_style']=early.le(.25).astype(float)
    f['stalk_style']=early.between(.25,.50,inclusive='right').astype(float)
    f['closer_style']=early.gt(.50).astype(float)
    f['front_pressure_count']=f.expected_front_count
    f['front_pressure_share']=f.front_pressure_count/field
    f['known_style_share']=early.groupby(x.race_id,observed=True).transform('count')/field
    f['front_under_pressure']=f.front_style*f.front_pressure_share
    f['closer_pressure_help']=f.closer_style*f.front_pressure_share
    f['relative_late']=f.prior_late_pct-f.prior_late_pct.groupby(x.race_id,observed=True).transform('mean')
    f['closing_pressure_fit']=-f.recent3_closing3f_z*f.front_pressure_share
    for col in ('recent3_speed_relative','recent3_closing3f_z','horse_win_rate','horse_top3_rate','horse_recent5_avg_finish','recent3_result_strength'):
        v=f[col]; g=v.groupby(x.race_id,observed=True)
        f[f'{col}_field_rank']=g.rank(pct=True)
        f[f'{col}_field_gap']=v-g.transform('mean')
    for col in core.CATEGORICAL: f[col]=f[col].fillna('__missing__').astype('category')
    return x,f

def verify_parity(runtime,x,features,core,output):
    candidates=x.loc[x.surface.isin(['芝','ダート']) & x.race_date.ge('2025-01-01')]
    meta=candidates.groupby('race_id',observed=True).agg(date=('race_date','first'),surface=('surface','first'))
    ids=[]
    for year in (2025,2026):
        for surf in ('芝','ダート'):
            pool=meta.loc[meta.date.dt.year.eq(year) & meta.surface.eq(surf)].sort_values('date').index.tolist()
            if pool: ids += [pool[0],pool[len(pool)//2],pool[-1]]
    sample=[]
    for race_id in dict.fromkeys(ids):
        g=x.loc[x.race_id.eq(race_id)].sort_values('horse_number')
        if g.gate.isna().any(): continue
        race={'race_date':str(g.race_date.iloc[0].date()),'racecourse':g.racecourse.iloc[0],
              'surface':g.surface.iloc[0],'distance_m':int(g.distance_m.iloc[0]),
              'going':g.going.iloc[0],'race_class':g.race_class.iloc[0]}
        cols=['horse_number','gate','horse_id','jockey_id','trainer_id','age','sex','weight_carried','horse_weight','horse_weight_change']
        runners=json.loads(g[cols].to_json(orient='records'))
        expected=runtime._feature_frame_full(race,runners)
        actual=features.loc[g.index].reset_index(drop=True)
        mismatches=[]; maxerr=0.0
        for col in expected:
            if col in core.CATEGORICAL:
                ok=(expected[col].astype(str).to_numpy()==actual[col].astype(str).to_numpy()).all()
            else:
                a=expected[col].to_numpy(float); b=actual[col].to_numpy(float)
                ok=np.allclose(a,b,rtol=1e-8,atol=2e-8,equal_nan=True)
                finite=np.isfinite(a)&np.isfinite(b)
                if finite.any(): maxerr=max(maxerr,float(np.max(np.abs(a[finite]-b[finite]))))
            if not ok:
                mismatches.append({'column':col,'expected':expected[col].astype(str).tolist(),'actual':actual[col].astype(str).tolist()})
        sample.append({'race_id':str(race_id),'runners':len(g),'feature_count':len(expected.columns),
                       'max_numeric_error':maxerr,'mismatches':mismatches})
        log(f'parity {race_id}: {len(mismatches)} mismatching features')
    (output/'parity.json').write_text(json.dumps(sample,ensure_ascii=False,indent=2))
    if not sample or any(s['mismatches'] for s in sample):
        raise RuntimeError('Production feature parity failed; do not publish hit-rate claims')
    return sample

def js_round(x):
    return np.floor(x+.5)

def rankings(pop,probs,numbers,weight,kind,base_order=None):
    m=1/np.asarray(pop,float); m/=m.sum()
    p=np.asarray(probs,float); p=p/p.sum(axis=0)
    alpha=weight/100
    if kind in ('overall','overall_raw'):
        mixed=alpha*m+(1-alpha)*(p@np.array([.5,.3,.2]))
        score=js_round(np.clip(50+mixed*len(pop)*35,45,98)) if kind=='overall' else mixed
        return np.lexsort((numbers,pop,-score))
    target=ROLES.index(kind)
    mixed=alpha*m+(1-alpha)*p[:,target]
    points=js_round(100*mixed/mixed.max())
    return np.lexsort((numbers,base_order,-points))

def paired_ci(a,b,dates,seed=20260925):
    _,day=np.unique(dates,return_inverse=True)
    n=np.bincount(day); delta=np.bincount(day,weights=a.astype(int)-b.astype(int))
    rng=np.random.default_rng(seed)
    ix=rng.integers(0,len(n),size=(2000,len(n)))
    draws=delta[ix].sum(axis=1)/n[ix].sum(axis=1)*100
    return {'difference_pp':float((a.mean()-b.mean())*100),
            '95pct_day_cluster_interval_pp':[float(v) for v in np.quantile(draws,[.025,.975])],
            'gained_races':int((a & ~b).sum()),'lost_races':int((~a & b).sum())}

def audit(pred,output):
    kinds=list(BASE_MARKET)
    excluded={}; race_meta=[]; records=[]
    for race_id,g in pred.groupby('race_id',observed=True,sort=False):
        reason=None
        if len(g)<=5: reason='five_or_fewer_starters'
        elif not (np.isfinite(g.popularity).all() and g.popularity.ge(1).all() and g.popularity.le(len(g)).all()): reason='invalid_popularity'
        elif any(g.finish_numeric.eq(j).sum()!=1 for j in (1,2,3)): reason='nonunique_or_missing_top3'
        if reason:
            excluded[reason]=excluded.get(reason,0)+1;continue
        g=g.sort_values('horse_number')
        pop=g.popularity.to_numpy(float); numbers=g.horse_number.to_numpy(int)
        probs=g[['p_first','p_second','p_third']].to_numpy(float)
        actual=[int(np.flatnonzero(g.finish_numeric.to_numpy()==j)[0]) for j in (1,2,3)]
        base=rankings(pop,probs,numbers,70,'overall'); base_order=np.empty(len(g),int);base_order[base]=np.arange(len(g))
        hit=np.zeros((len(kinds),len(MARKET_GRID),5),bool)
        for ki,kind in enumerate(kinds):
            target=0 if kind.startswith('overall') else ROLES.index(kind)
            for wi,weight in enumerate(MARKET_GRID):
                order=rankings(pop,probs,numbers,weight,kind,base_order)
                at=int(np.flatnonzero(order==actual[target])[0])+1
                hit[ki,wi]=np.arange(1,6)>=at
        records.append(hit)
        race_meta.append({'race_id':str(race_id),'race_date':str(g.race_date.iloc[0].date()),
                          'surface':str(g.surface.iloc[0]),'field_size':len(g),'racecourse':str(g.racecourse.iloc[0])})
    hits=np.stack(records); meta=pd.DataFrame(race_meta); dates=pd.to_datetime(meta.race_date)
    period=np.where(dates.dt.year.eq(2025),'selection_2025','audit_2026')
    rows=[]
    for per in ('selection_2025','audit_2026'):
        mask=period==per
        if not mask.any(): raise RuntimeError(f'Empty period: {per}')
        for ki,kind in enumerate(kinds):
            for wi,weight in enumerate(MARKET_GRID):
                rates=hits[mask,ki,wi].mean(axis=0); c=hits[mask,ki,wi].sum(axis=0)
                row={'period':per,'ranking':kind,'market_pct':weight,'rein_pct':100-weight,'races':int(mask.sum())}
                for k in range(5):
                    row[f'top{k+1}_hits']=int(c[k]); row[f'top{k+1}_hit_rate']=float(rates[k])
                    row[f'rank{k+1}_hit_rate']=float(rates[k]-(rates[k-1] if k else 0))
                rows.append(row)
    table=pd.DataFrame(rows);table.to_csv(output/'blend_grid.csv',index=False)
    selected={}; testmask=period=='audit_2026'
    for ki,kind in enumerate(kinds):
        candidates=[r for r in rows if r['period']=='selection_2025' and r['ranking']==kind]
        chosen=max(candidates,key=lambda r:(r['top5_hits'],r['top3_hits'],r['top1_hits'],-abs(r['market_pct']-BASE_MARKET[kind]),-r['market_pct']))
        chosenweight=chosen['market_pct']; selected[kind]={'market_pct':chosenweight,'rein_pct':100-chosenweight,'selection_2025':chosen}
        testrow=next(r for r in rows if r['period']=='audit_2026' and r['ranking']==kind and r['market_pct']==chosenweight)
        baserow=next(r for r in rows if r['period']=='audit_2026' and r['ranking']==kind and r['market_pct']==BASE_MARKET[kind])
        a=hits[testmask,ki,MARKET_GRID.index(chosenweight),4]; b=hits[testmask,ki,MARKET_GRID.index(BASE_MARKET[kind]),4]
        selected[kind].update({'audit_2026':testrow,'current_audit_2026':baserow,'paired_top5':paired_ci(a,b,meta.loc[testmask,'race_date'].to_numpy())})
    shared=[]
    for wi,w in enumerate(MARKET_GRID):
        for per in ('selection_2025','audit_2026'):
            mask=period==per
            allhit=hits[mask,1:4,wi,4].all(axis=1)
            shared.append({'period':per,'market_pct':w,'races':int(mask.sum()),'all_three_top5_hits':int(allhit.sum()),'all_three_top5_rate':float(allhit.mean())})
    pd.DataFrame(shared).to_csv(output/'joint_grid.csv',index=False)
    currentall=hits[testmask,1:4,0,4].all(axis=1)
    chosenall=np.ones(int(testmask.sum()),bool)
    for role in ROLES: chosenall &= hits[testmask,kinds.index(role),MARKET_GRID.index(selected[role]['market_pct']),4]
    report={'description':'Frozen deployed-model popularity blend audit; no production changes',
            'market_weights':MARKET_GRID,'current_market_pct':BASE_MARKET,
            'selection_rule':'2025 Top5, then Top3, then Top1, then closest to current weight; no 2026 selection',
            'model_internal_overall_weights':{'first':.5,'second':.3,'third':.2},
            'market_transform':'normalized reciprocal popularity rank, NOT inverse win odds',
            'ranking_semantics':'overall reproduces JS round/clamp45..98 and popularity tie-break; roles reproduce integer suitability and fixed current overall70 tie-break; overall_raw is diagnostic only',
            'cohort':'JRA turf/dirt; >5 starters; complete popularity; unique finishers at 1,2,3; same races for all weights',
            'excluded':excluded,'periods':{per:{'races':int((period==per).sum()),'from':meta.loc[period==per,'race_date'].min(),'through':meta.loc[period==per,'race_date'].max()} for per in np.unique(period)},
            'selected':selected,'joint_top5':{'current_rate':float(currentall.mean()),'chosen_rate':float(chosenall.mean()),'comparison':paired_ci(chosenall,currentall,meta.loc[testmask,'race_date'].to_numpy())},
            'limitations':['Final historical popularity, not a 10-min-before snapshot.','2026 was previously used in model audits, so this is retrospective, not a virgin holdout.','No return-on-investment optimization.','Ratios only optimize this discrete 5-point grid under frozen model and scoring rules.']}
    subgroup=[]
    for column in ('surface','racecourse','field_size'):
        vals=meta[column].astype(str) if column!='field_size' else pd.cut(meta.field_size,[5,9,13,30],labels=['6-9','10-13','14+']).astype(str)
        for val in vals.unique():
            mask=testmask & vals.eq(val).to_numpy()
            for ki,kind in enumerate(kinds[:4]):
                a=hits[mask,ki,MARKET_GRID.index(selected[kind]['market_pct']),4];b=hits[mask,ki,MARKET_GRID.index(BASE_MARKET[kind]),4]
                subgroup.append({'group':column,'value':val,'ranking':kind,'races':int(mask.sum()),'current_top5':float(b.mean()),'selected_top5':float(a.mean()),'change_pp':float((a.mean()-b.mean())*100)})
    pd.DataFrame(subgroup).to_csv(output/'subgroups.csv',index=False)
    np.savez_compressed(output/'race_hits.npz',hits=hits)
    meta.to_csv(output/'races.csv',index=False)
    return report

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--bundle-root',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args(); args.output.mkdir(parents=True,exist_ok=True)
    repo=Path(__file__).resolve().parents[1]
    os.environ.setdefault('OMP_NUM_THREADS','2'); os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
    sys.path.insert(0,str(repo/'rein-web'/'api'))
    import rein_core as core
    root=args.bundle_root
    manifest=json.loads((root/'manifest.json').read_text())
    for item in manifest['files']:
        path=root/item['path']; actual=hashlib.sha256(path.read_bytes()).hexdigest()
        if actual!=item['sha256']: raise RuntimeError(f'Bad bundle hash: {item["path"]}')
    log('Verified model/history hashes')
    runtime=core.ReinRuntime.load(root,manifest['version'])
    if runtime.schema['trained_through']!='2024-12-31' or runtime.second_joint_schema['trained_through']!='2024-12-31': raise RuntimeError('Unexpected training cutoff')
    raw=pd.read_parquet(root/'data'/'history.parquet')
    log(f'Build production features from {len(raw)} historical runners')
    x,f=build_features(raw,core)
    log(f'Features ready: {f.shape}')
    parity=verify_parity(runtime,x,f,core,args.output)
    chosen=x.surface.isin(['芝','ダート']) & x.race_date.between('2025-01-01','2026-12-31')
    ix=x.index[chosen]; pred=x.loc[ix,['race_id','race_date','racecourse','surface','horse_number','popularity','finish_numeric']].copy()
    pred['popularity']=numeric(pred.popularity)
    log(f'Infer {len(pred)} rows with frozen production models')
    first=f.loc[ix,runtime.schema['feature_order']].copy();first['horse_weight_change']=first.horse_weight_change.replace(0,np.nan)
    third_order=runtime.schema.get('role_feature_order',{}).get('third',runtime.schema['feature_order'])
    arrays={'first':runtime.models['first'].predict(first,num_threads=2,validate_features=True),
            'third':runtime.models['third'].predict(f.loc[ix,third_order],num_threads=2,validate_features=True),
            'second':runtime.second_joint_model.predict(f.loc[ix,runtime.second_joint_schema['feature_order']],num_threads=2,validate_features=True)[:,int(runtime.second_joint_schema['second_class_index'])]}
    for role in ROLES:
        a=np.clip(arrays[role],1e-12,None)
        if not np.isfinite(a).all(): raise RuntimeError(f'Invalid {role} predictions')
        pred[f'p_{role}']=a
    pred.to_csv(args.output/'frozen_predictions.csv.gz',index=False,compression='gzip')
    log('Evaluate all four rankings at 21 mixture weights')
    report=audit(pred,args.output)
    report['provenance']={'source_commit':os.environ.get('GITHUB_SHA','local'),'model_bundle':manifest['version'],
        'second_model':runtime.second_joint_schema['version'],'history_sha256':hashlib.sha256((root/'data'/'history.parquet').read_bytes()).hexdigest(),
        'history_rows':len(raw),'history_races':int(raw.race_id.nunique()),'parity_races':len(parity),'parity_all_passed':True,
        'second_model_sha256':hashlib.sha256((repo/'rein-web/api/models/second_joint_v5.txt.gz').read_bytes()).hexdigest()}
    (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    text=['# JRA frozen-production blend audit','',str(report['periods']),'',
          '|Ranking|Selected market:REIN|Current Top5|Selected Top5|Change pp|','|---|---:|---:|---:|---:|']
    for kind,s in report['selected'].items():
        text.append(f"|{kind}|{s['market_pct']}:{s['rein_pct']}|{s['current_audit_2026']['top5_hit_rate']:.4%}|{s['audit_2026']['top5_hit_rate']:.4%}|{s['paired_top5']['difference_pp']:+.4f}|")
    text+=['','## Limitations']+['- '+s for s in report['limitations']]
    (args.output/'summary.md').write_text('\n'.join(text)+'\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'): Path(os.environ['GITHUB_STEP_SUMMARY']).write_text('\n'.join(text)+'\n')
    log(json.dumps({'selected':{k:v['market_pct'] for k,v in report['selected'].items()},'joint':report['joint_top5']},ensure_ascii=False))

if __name__=='__main__': main()
