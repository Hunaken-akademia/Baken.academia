"""Isolated research: market baseline versus point-in-time horse-racing data.
No downloads from racing sites, credentials, deployment or production writes.
Training <=2024; choose on 2025H1; freeze; 2025H2 stability; 2026 retrospective.
"""
from __future__ import annotations
import argparse, hashlib, json, os, sys, time
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb
from scipy.special import expit, logit

ROLES = {"first": 1, "second": 2, "third": 3}
THRESHOLDS = [0.0, 0.10, 0.25, 0.50, 1.0]
SEED = 20260925

def log(s): print(time.strftime('%H:%M:%S'), s, flush=True)
def dump(path, obj): path.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False))

def new_features(x, f, target):
    f = f.copy(); z = x.copy(); n = len(x); ix = np.arange(n)
    new = x.horse_id.ne(x.horse_id.shift()).to_numpy()
    start = np.maximum.accumulate(np.where(new, ix, 0))
    daynew = new | x.race_date.ne(x.race_date.shift()).to_numpy()
    stop = np.maximum.accumulate(np.where(daynew, ix, 0))
    def rolling(v, w):
        a = pd.to_numeric(v, errors='coerce').to_numpy(float); valid = np.isfinite(a)
        c = np.r_[0., np.cumsum(np.where(valid,a,0.))]; count = np.r_[0,np.cumsum(valid)]
        left = np.maximum(start,stop-w); den = count[stop]-count[left]
        return np.divide(c[stop]-c[left],den,out=np.full(n,np.nan),where=den>0)
    field = f.field_size
    surprise = (pd.to_numeric(x.popularity,errors='coerce')-x.finish_numeric)/field
    for w in [3,5,10]:
        f[f'form_surprise_last{w}'] = rolling(surprise,w)
        f[f'form_speed_last{w}'] = rolling(x.speed_relative,w)
    f['form_speed_trend'] = f.form_speed_last3-f.form_speed_last10
    f['form_surprise_trend'] = f.form_surprise_last3-f.form_surprise_last10
    f['body_change_abs'] = f.horse_weight_change.abs()
    f['body_change_pct'] = f.horse_weight_change/f.horse_weight
    f['body_load_ratio'] = f.weight_carried/f.horse_weight
    f['body_weight_vs_recent3'] = f.horse_weight-rolling(x.horse_weight,3)
    f['body_load_change'] = f.weight_carried-rolling(x.weight_carried,1)
    f['month_sin'] = np.sin(x.race_date.dt.month*2*np.pi/12)
    f['month_cos'] = np.cos(x.race_date.dt.month*2*np.pi/12)
    f['history_coverage'] = f.horse_starts.gt(0).groupby(x.race_id,observed=True).transform('mean')
    f['field_speed_std'] = f.recent3_speed_relative.groupby(x.race_id,observed=True).transform('std')
    z['style_key'] = np.select([f.prior_early_pct.le(.25),f.prior_early_pct.le(.5),f.prior_early_pct.gt(.5)],[1,2,3],default=0)
    z['target_label'] = z.finish_numeric.eq(target).astype(float)
    specs = [
        (['horse_id','surface'],'fit_surface'), (['horse_id','distance_bucket'],'fit_distance'),
        (['horse_id','racecourse'],'fit_course'), (['horse_id','wet_key'],'fit_wet'),
        (['jockey_id','racecourse','surface'],'people_jockey_course'),
        (['trainer_id','surface'],'people_trainer_surface'),
        (['horse_id','jockey_id'],'people_partnership'),
        (['racecourse','surface','distance_bucket','gate'],'gate_course_bias'),
        (['racecourse','surface','style_key'],'pace_course_style')]
    for keys, prefix in specs:
        d=z.groupby(keys+['race_date'],observed=True,dropna=False).agg(n=('horse_id','size'),hits=('target_label','sum')).reset_index()
        d=d.sort_values(keys+['race_date']).reset_index(drop=True)
        p=d.groupby(keys,observed=True,dropna=False)[['n','hits']].cumsum()-d[['n','hits']]
        d[prefix+'_starts']=p.n;d[prefix+'_rate']=(p.hits+6.4)/(p.n+80)
        cols=[prefix+'_starts',prefix+'_rate']
        joined=z[keys+['race_date']].merge(d[keys+['race_date']+cols],on=keys+['race_date'],how='left',validate='many_to_one',sort=False)
        for col in cols: f[col]=joined[col].to_numpy()
    # Market variables are rank based unless an actual historical odds column exists.
    pop=pd.to_numeric(x.popularity,errors='coerce').astype(float)
    f['market_rank']=pop; f['market_logrank']=np.log(pop.clip(lower=1))
    f['market_inv_rank']=1/pop.clip(lower=1)
    f['market_share']=f.market_inv_rank/f.market_inv_rank.groupby(x.race_id,observed=True).transform('sum')
    f['market_rank_fraction']=pop/field
    f['market_field_size']=field
    actual_odds=None
    for col in ('win_odds','odds','win_odd','odds_win'):
        if col in x:
            a=pd.to_numeric(x[col],errors='coerce')
            if (a.ge(1)&a.lt(100000)).mean()>.98:
                actual_odds=col;f['market_logodds']=np.log(a.clip(lower=1));f['market_odds_share']=1/a
                f['market_odds_share']/=f.market_odds_share.groupby(x.race_id,observed=True).transform('sum')
                break
    # Relative matchup against the favorite, without assuming the favorite wins.
    favorites=x.assign(_pop=pop).sort_values(['race_id','_pop','horse_number']).drop_duplicates('race_id').index
    for col in ('recent3_speed_relative','recent3_closing3f_z','horse_top3_rate','prior_early_pct'):
        leaders=pd.Series(f.loc[favorites,col].to_numpy(),index=x.loc[favorites,'race_id'])
        f['matchup_'+col]=f[col].to_numpy()-x.race_id.map(leaders).to_numpy()
    return f,actual_odds

def partition_features(cols):
    groups={k:[] for k in ('context','recent_form','experience','condition_fit','pace','body_load','people','gate','matchup')}
    market=[]
    for c in cols:
        if c.startswith('market_'): market.append(c);continue
        if c.startswith('matchup_'): k='matchup'
        elif c.startswith(('jockey','trainer','people_')): k='people'
        elif c.startswith(('body_','horse_weight','weight_carried')): k='body_load'
        elif c.startswith(('gate','horse_number')): k='gate'
        elif c.startswith(('fit_','horse_surface','horse_distance','horse_course','horse_wet')): k='condition_fit'
        elif any(v in c for v in ('pressure','style','early','late','front_','pace_','position_gain')): k='pace'
        elif c.startswith(('prior_','recent3_','recent5_','form_','horse_recent','days_since')): k='recent_form'
        elif c.startswith(('horse_','history_exact')): k='experience'
        else: k='context'
        groups[k].append(c)
    assert len(market)+sum(map(len,groups.values()))==len(cols)
    return market,groups

def probabilities(v, codes):
    v=np.maximum(np.asarray(v,float),1e-12)
    return v/np.bincount(codes,weights=v)[codes]

def make_cohort(x, f):
    q=x.loc[x.surface.isin(['芝','ダート'])].copy()
    q['popularity']=pd.to_numeric(q.popularity,errors='coerce')
    sizes=q.groupby('race_id',observed=True).size()
    invalid=q.loc[~np.isfinite(q.popularity)|q.popularity.lt(1)|q.popularity.gt(q.race_id.map(sizes)),'race_id'].unique()
    counts=q.groupby('race_id',observed=True).finish_numeric.agg(lambda a:all(a.eq(k).sum()==1 for k in (1,2,3)))
    keep=sizes.index[(sizes>5)&counts.reindex(sizes.index)&~sizes.index.isin(invalid)]
    ids=q.loc[q.race_id.isin(keep)].sort_values(['race_date','race_id','horse_number']).index
    return x.loc[ids].reset_index(drop=True),f.loc[ids].reset_index(drop=True)

def describe_hits(h, mask):
    a=h[mask];n=len(a)
    return {'races':n,'hits':int(a.sum()),'rate':float(a.mean()) if n else 0.}

def cluster_ci(h, b, dates, boot=3000):
    dates=np.asarray(dates);_,code=np.unique(dates,return_inverse=True)
    ns=np.bincount(code);d=np.bincount(code,weights=h.astype(int)-b.astype(int))
    rng=np.random.default_rng(SEED);draw=rng.integers(len(ns),size=(boot,len(ns)))
    vals=100*d[draw].sum(axis=1)/ns[draw].sum(axis=1)
    return {'difference_pp':float(100*(h.mean()-b.mean())), 'ci95_pp':np.quantile(vals,[.025,.975]).tolist(),
            'gained':int((h&~b).sum()),'lost':int((~h&b).sum())}

def run(args):
    root=Path(args.bundle_root);out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'rein-web/api'))
    import rein_core as core
    from rein_blend_top5_audit import build_features,verify_parity,rankings
    role=args.role;target=ROLES[role]
    manifest=json.loads((root/'manifest.json').read_text())
    for item in manifest['files']:
        if hashlib.sha256((root/item['path']).read_bytes()).hexdigest()!=item['sha256']:raise RuntimeError('Invalid immutable bundle')
    raw=pd.read_parquet(root/'data/history.parquet');runtime=core.ReinRuntime.load(root,manifest['version'])
    if runtime.schema['trained_through']!='2024-12-31':raise RuntimeError('Training cutoff changed')
    x,f=build_features(raw,core);log(f'{role}: original {f.shape}')
    verify_parity(runtime,x,f,core,out)
    f,odds_column=new_features(x,f,target)
    meta,f=make_cohort(x,f)
    train=meta.race_date.lt('2025-01-01').to_numpy();ev=meta.race_date.ge('2025-01-01').to_numpy()
    e=meta.loc[ev].reset_index(drop=True);ef=f.loc[ev].reset_index(drop=True)
    for c in f.select_dtypes('category').columns:
        # Prevent categories that occur only in held-out periods receiving learned codes.
        cats=f.loc[train,c].dropna().unique().tolist()
        f[c]=pd.Categorical(f[c],categories=cats);ef[c]=pd.Categorical(ef[c],categories=cats)
    y=meta.finish_numeric.eq(target).astype(int).to_numpy()
    codes,_=pd.factorize(e.race_id,sort=False);nr=codes.max()+1
    starts=np.r_[0,np.flatnonzero(np.diff(codes))+1];ends=np.r_[starts[1:],len(e)]
    rmeta=e.iloc[starts][['race_id','race_date','racecourse','surface','going','distance_m','race_class']].copy().reset_index(drop=True)
    rmeta['field_size']=ends-starts
    masks={'selection_2025H1':rmeta.race_date.between('2025-01-01','2025-06-30').to_numpy(),
           'confirmation_2025H2':rmeta.race_date.between('2025-07-01','2025-12-31').to_numpy(),
           'audit_2026':rmeta.race_date.ge('2026-01-01').to_numpy()}
    pop=e.popularity.to_numpy(float);hn=e.horse_number.to_numpy(int);actual=e.finish_numeric.eq(target).to_numpy()
    group_indices=[np.arange(s,t) for s,t in zip(starts,ends)]
    top4=[];fifth=[];outside=[];pop_hits=np.zeros((nr,5),bool);sixth=[]
    for j,ix in enumerate(group_indices):
        order=ix[np.lexsort((hn[ix],pop[ix]))];top4.append(order[:4]);fifth.append(order[4]);outside.append(ix[pop[ix]>=6]);sixth.append(order[5])
        for k in range(5):pop_hits[j,k]=actual[order[:k+1]].any()
    fifth=np.array(fifth);sixth=np.array(sixth);top4_hit=pop_hits[:,3]
    # Freeze a written search space before any held-out metrics are selected.
    market,groups=partition_features(list(f));allcols=list(f)
    configs=[('market_only',market,7,140),('all_l7',allcols,7,220),('all_l15',allcols,15,220),('all_l31',allcols,31,220)]
    configs += [('add_'+g,market+cols,15,180) for g,cols in groups.items()]
    configs += [('without_'+g,[c for c in allcols if c not in cols],15,180) for g,cols in groups.items()]
    configs += [('no_market',[c for c in allcols if c not in market],15,220)]
    dump(out/'protocol.json',{'training':'2019..2024','selection':'2025H1','confirmation':'2025H2','audit':'2026 retrospective, previously inspected',
          'selection_metric':'Top5 exact-finisher count; Top3 then Top1 ties; no 2026 selection',
          'swap_thresholds':THRESHOLDS,'minimum_selection_swaps':100,
          'families':groups,'market_columns':market,'configs':[{'name':n,'leaves':l,'trees':t,'feature_count':len(c)} for n,c,l,t in configs]})
    pred={}; models={};importance=[];fits=0
    X=f.loc[train];Y=y[train]
    for name,cols,leaves,trees in configs:
        tic=time.time();m=lgb.LGBMClassifier(n_estimators=trees,num_leaves=leaves,learning_rate=.035,
          min_child_samples=400,reg_lambda=15,feature_fraction=.85,verbosity=-1,n_jobs=2,random_state=SEED,
          max_bin=127)
        m.fit(X[cols],Y)
        a=m.predict_proba(ef[cols],num_threads=2)[:,1]
        pred[name]=probabilities(a,codes);fits+=1
        if name in ('market_only','all_l15'):
            models[name]=m
            for c,v in zip(cols,m.booster_.feature_importance(importance_type='gain')):importance.append({'model':name,'feature':c,'gain':float(v)})
            m.booster_.save_model(str(out/(role+'_'+name+'.txt')))
        log(f'{role} {name}: {len(cols)} features in {time.time()-tic:.1f}s')
    # Learn a correction to the already-fitted market model; inference adds its raw margin.
    base_train=models['market_only'].predict(X[market],raw_score=True,num_threads=2)
    base_eval=models['market_only'].predict(ef[market],raw_score=True,num_threads=2)
    ds=lgb.Dataset(X[allcols],label=Y,init_score=base_train,free_raw_data=False)
    residual=lgb.train({'objective':'binary','num_leaves':7,'learning_rate':.03,'min_data_in_leaf':600,
        'lambda_l2':25,'feature_fraction':.85,'verbosity':-1,'num_threads':2,'seed':SEED,'max_bin':127},ds,num_boost_round=250)
    correction=residual.predict(ef[allcols],raw_score=True,num_threads=2);fits+=1
    for scale in (.25,.5,1.):pred['residual_'+str(scale)]=probabilities(expit(base_eval+scale*correction),codes)
    residual.save_model(str(out/(role+'_residual.txt')))
    # Existing production scores, never used as training features for the new models.
    first=ef[runtime.schema['feature_order']].copy();first['horse_weight_change']=first.horse_weight_change.replace(0,np.nan)
    third_order=runtime.schema.get('role_feature_order',{}).get('third',runtime.schema['feature_order'])
    # Reset to production categories, not the new-model training categories, for parity.
    # Original category strings are preserved in meta for all seven categorical inputs.
    for c in core.CATEGORICAL:
        first[c]=pd.Categorical(e[c]);ef[c]=pd.Categorical(e[c])
    probs=np.column_stack([runtime.models['first'].predict(first,num_threads=2),
          runtime.second_joint_model.predict(ef[runtime.second_joint_schema['feature_order']],num_threads=2)[:,2],
          runtime.models['third'].predict(ef[third_order],num_threads=2)])
    pred['current_rein']=probabilities(probs[:,target-1],codes)
    current=np.zeros((nr,5),bool);currentoverall=np.zeros((nr,5),bool)
    for j,ix in enumerate(group_indices):
        order=rankings(pop[ix],probs[ix],hn[ix],70,'overall');base_order=np.empty(len(ix),int);base_order[order]=np.arange(len(ix))
        roleorder=rankings(pop[ix],probs[ix],hn[ix],0,role,base_order)
        for k in range(5):
            current[j,k]=actual[ix[roleorder[:k+1]]].any();currentoverall[j,k]=actual[ix[order[:k+1]]].any()
    hits={};outpicks={};gaps={};records=[];swap_records=[];swaps={}
    for name,p in pred.items():
        h=np.zeros((nr,5),bool);picks=[]
        for j,ix in enumerate(group_indices):
            order=ix[np.lexsort((hn[ix],pop[ix],-p[ix]))]
            for k in range(5):h[j,k]=actual[order[:k+1]].any()
            ox=outside[j];picks.append(ox[np.lexsort((hn[ox],pop[ox],-p[ox]))][0])
        picks=np.array(picks);outside_hit=actual[picks];always=top4_hit|outside_hit
        hits[name]=h;outpicks[name]=picks;gap=np.log(np.maximum(p[picks],1e-12)/np.maximum(p[fifth],1e-12));gaps[name]=gap
        for period,mask in masks.items():
            row={'model':name,'period':period,'races':int(mask.sum()),'outsider_hits':int(outside_hit[mask].sum()),'always4plus1_hits':int(always[mask].sum()),
                 'log_loss':float(-np.log(p[e.finish_numeric.eq(target).to_numpy()][mask]).mean())}
            for k in range(5):row['top'+str(k+1)+'_hits']=int(h[mask,k].sum())
            records.append(row)
        for threshold in THRESHOLDS:
            sw=gap>=threshold;hh=top4_hit|np.where(sw,outside_hit,actual[fifth]);key=name+'@'+str(threshold);swaps[key]=(hh,sw)
            for period,mask in masks.items():swap_records.append({'key':key,'model':name,'threshold':threshold,'period':period,'races':int(mask.sum()),
                  'swaps':int(sw[mask].sum()),'hits':int(hh[mask].sum()),'gained':int((hh&~pop_hits[:,4]&mask).sum()),'lost':int((~hh&pop_hits[:,4]&mask).sum())})
    grid=pd.DataFrame(records);sg=pd.DataFrame(swap_records)
    selection=grid.loc[grid.period.eq('selection_2025H1')]
    def choose(col):
        a=selection.sort_values([col,'top3_hits','top1_hits','model'],ascending=[False,False,False,True])
        return str(a.iloc[0].model)
    chosen_full=choose('top5_hits');chosen_out=choose('outsider_hits')
    ss=sg.loc[sg.period.eq('selection_2025H1')&sg.swaps.ge(100)].copy()
    ss=ss.sort_values(['hits','swaps','key'],ascending=[False,True,True])
    baseline_h1=int(pop_hits[masks['selection_2025H1'],4].sum())
    chosen_swap=str(ss.iloc[0].key) if len(ss) and int(ss.iloc[0].hits)>baseline_h1 else 'no_swap'
    frozen={'full_top5_model':chosen_full,'outsider_model':chosen_out,'selective_swap':chosen_swap}
    dump(out/'frozen_selection.json',frozen)
    checks={};predcols={}
    for name in ('market_only',chosen_full,chosen_out):
        h=hits[name][:,4];picks=outpicks[name];ah=top4_hit|actual[picks]
        for label,hh in [(name+'_full',h),(name+'_always4plus1',ah)]:
            checks[label]={}
            for period,mask in masks.items():checks[label][period]={**describe_hits(hh,mask),'versus_popularity':cluster_ci(hh[mask],pop_hits[mask,4],rmeta.race_date[mask])}
    swap_h,swap_flag=(pop_hits[:,4].copy(),np.zeros(nr,bool)) if chosen_swap=='no_swap' else swaps[chosen_swap]
    for label,h in [('selected_swap',swap_h),('current_rein',current[:,4]),('current_overall',currentoverall[:,4])]:
        checks[label]={period:{**describe_hits(h,mask),'versus_popularity':cluster_ci(h[mask],pop_hits[mask,4],rmeta.race_date[mask])} for period,mask in masks.items()}
    # Save every candidate as research evidence; final choices above never look at 2026.
    predframe=e[['race_id','race_date','horse_number','popularity','finish_numeric','racecourse','surface']].copy()
    for name,p in pred.items():predframe[name]=p
    predframe.to_csv(out/'candidate_predictions.csv.gz',index=False,compression='gzip')
    grid.to_csv(out/'all_models.csv',index=False);sg.to_csv(out/'all_swaps.csv',index=False)
    pd.DataFrame(importance).to_csv(out/'feature_importance.csv',index=False)
    rmeta['popularity_top5_hit']=pop_hits[:,4].astype(int);rmeta['current_rein_hit']=current[:,4].astype(int)
    rmeta['current_overall_hit']=currentoverall[:,4].astype(int);rmeta['market_only_hit']=hits['market_only'][:,4].astype(int)
    rmeta['selected_full_hit']=hits[chosen_full][:,4].astype(int);rmeta['selected_outsider_hit']=actual[outpicks[chosen_out]].astype(int)
    rmeta['selected_4plus1_hit']=(top4_hit|actual[outpicks[chosen_out]]).astype(int)
    rmeta['selected_swap_hit']=swap_h.astype(int);rmeta['swapped']=swap_flag.astype(int)
    swap_model=chosen_swap.split('@')[0] if chosen_swap!='no_swap' else chosen_out
    rmeta['outside_pick_number']=hn[outpicks[swap_model]];rmeta['outside_pick_popularity']=pop[outpicks[swap_model]]
    rmeta.to_csv(out/'race_comparison.csv',index=False)
    stability=checks['selected_swap']['confirmation_2025H2']['versus_popularity']['difference_pp']>0
    audit=checks['selected_swap']['audit_2026']['versus_popularity']
    report={'role':role,'target_finish':target,'fits':fits,'candidate_count':len(pred),'features':len(f.columns),'market_features':market,
      'groups':{k:len(v) for k,v in groups.items()},'actual_odds_column':odds_column,
      'data':{'history_rows':len(raw),'history_races':int(raw.race_id.nunique()),'raw_columns':list(raw.columns),'train_rows':int(train.sum()),
              'train_races':int(meta.loc[train,'race_id'].nunique()),'periods':{k:int(m.sum()) for k,m in masks.items()}},
      'selected':frozen,'checks':checks,'stability_positive':stability,'audit_ci_positive':audit['ci95_pp'][0]>0,
      'production_changed':False,'source_commit':os.environ.get('GITHUB_SHA','local'),
      'limitations':['2026 reused retrospective audit; not virgin test','historical final popularity, not pre-race snapshots',
       'new models frozen through 2024; selection 2025H1; 2025H2 is confirmation, not retuning',
       'multiple candidate search not fully corrected by bootstrap intervals','candidate ranks use raw probability, production comparison uses original rounded points',
       'no ROI claim, no new race-site collection, no arbitrary outcome-based subgroup selection','actual odds only if suitable source column exists']}
    dump(out/'report.json',report)
    log(json.dumps({'role':role,'selected':frozen,'swap_audit':audit,'stability':stability},ensure_ascii=False))
    summary=f'# REIN market-edge research: {role}\n\n'+json.dumps({'selected':frozen,'audit':audit,'stability':stability},ensure_ascii=False,indent=2)
    (out/'summary.md').write_text(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):Path(os.environ['GITHUB_STEP_SUMMARY']).write_text(summary)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--bundle-root',required=True);p.add_argument('--output',required=True);p.add_argument('--role',choices=ROLES,required=True)
    run(p.parse_args())
