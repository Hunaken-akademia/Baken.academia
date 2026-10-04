"""Odds-independent accuracy candidates. Fixed 2025H1 selection, H2 confirmation,
2026 retrospective audit. Exact finishes, with separate outsider guardrails.
No production model activation. Only reports and candidate models are exported.
"""
from pathlib import Path
import argparse, json, sys
import numpy as np
import pandas as pd
import lightgbm as lgb
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'src'),str(ROOT/'rein-web/api')]
ROLES=['first','second','third']


def ranks(data, values):
    q=pd.DataFrame({'race':data.race_id,'horse':data.horse_number,'score':np.asarray(values)},index=data.index)
    q=q.sort_values(['race','score','horse'],ascending=[True,False,True],kind='stable')
    return (q.groupby('race',sort=False).cumcount()+1).reindex(data.index)


def actuals(data,target):
    a=data.loc[data.finish_position.eq(target)]
    return a.loc[a.groupby('race_id').race_id.transform('size').eq(1)]


def metrics(data,values,target):
    rr=ranks(data,values);a=actuals(data,target);out={}
    for name,cut in [('all',1),('pop4plus',4),('pop6plus',6),('pop10plus',10)]:
        subset=a if cut==1 else a.loc[a.popularity.ge(cut)]
        out[name]={'races':len(subset),**{f'top{k}':{'hits':int(rr.loc[subset.index].le(k).sum()),'rate':float(rr.loc[subset.index].le(k).mean()) if len(subset) else None} for k in [1,3,5]}}
    return out


def paired(data,proposed,current,target,cut=1):
    a=actuals(data,target)
    if cut>1:a=a.loc[a.popularity.ge(cut)]
    aa=ranks(data,proposed).loc[a.index].le(5);bb=ranks(data,current).loc[a.index].le(5)
    diff=aa.astype(int)-bb.astype(int)
    daily=pd.DataFrame({'delta':diff,'date':data.loc[a.index,'race_date']}).groupby('date').delta.agg(['sum','count']).to_numpy()
    ci=None
    if len(daily)>=30:
        rng=np.random.default_rng(20261005);idx=rng.integers(len(daily),size=(2000,len(daily)));v=daily[idx].sum(axis=1)
        ci=np.quantile(v[:,0]/np.maximum(v[:,1],1),[.025,.975]).tolist()
    return {'races':len(a),'rescued':int((aa&~bb).sum()),'lost':int((~aa&bb).sum()),'net':int(diff.sum()),'gain':float(diff.mean()) if len(diff) else None,'date_cluster_95ci':ci}


def evaluate(data,predictions,target):
    periods={'selection2025H1':data.race_date.between('2025-01-01','2025-06-30'),'confirmation2025H2':data.race_date.between('2025-07-01','2025-12-31'),'retrospective2026':data.race_date.ge('2026-01-01')}
    selection={name:metrics(data.loc[periods['selection2025H1']],score[periods['selection2025H1']],target) for name,score in predictions.items()}
    baseline=selection['current_recipe']
    eligible=[name for name,z in selection.items() if name!='popularity' and z['all']['top5']['hits']>=baseline['all']['top5']['hits'] and z['pop4plus']['top5']['hits']>=baseline['pop4plus']['top5']['hits']]
    def key(name):
        z=selection[name]['all'];return (z['top5']['hits'],z['top3']['hits'],z['top1']['hits'],name=='current_recipe')
    selected=max(eligible,key=key)
    out={'selected':selected,'selection':selection,'periods':{},'comparisons':{},'segments':{}}
    for period,mask in periods.items():
        out['periods'][period]={name:metrics(data.loc[mask],predictions[name][mask],target) for name in dict.fromkeys(['current_recipe',selected,'popularity'])}
        out['comparisons'][period]={label:paired(data.loc[mask],predictions[selected][mask],predictions['current_recipe'][mask],target,cut) for label,cut in [('all',1),('pop4plus',4),('pop10plus',10)]}
    passed=selected!='current_recipe'
    for period in ['confirmation2025H2','retrospective2026']:
        z=out['comparisons'][period];m=out['periods'][period]
        passed=passed and bool(z['all']['date_cluster_95ci'] and z['all']['date_cluster_95ci'][0]>0 and z['pop4plus']['gain'] is not None and z['pop4plus']['gain']>=0 and m[selected]['all']['top3']['hits']>=m['current_recipe']['all']['top3']['hits'])
    out['gate']='offline_pass' if passed else 'keep_current'
    mask=periods['retrospective2026']
    for keycol in ['racecourse','going','surface','distance_band']:
        if keycol not in data:continue
        out['segments'][keycol]={}
        for value,g in data.loc[mask].groupby(keycol,observed=True):
            if g.race_id.nunique()<100:continue
            out['segments'][keycol][str(value)]={name:metrics(g,predictions[name][g.index],target) for name in dict.fromkeys(['current_recipe',selected])}
    return out


def nar_dataset():
    from nar_live_model import normalize_courses,prior_features,inputs_by_mode
    from nar_condition_validation import fit,predict,local_models,conditioned_predict
    paths=[p for p in (ROOT/'.nar-dataset').rglob('nar-*.parquet') if not any(s in p.name for s in ['-odds-','-payouts','-manifest'])]
    if not paths:raise ValueError('Missing NAR archive data')
    d=normalize_courses(pd.concat([pd.read_parquet(p) for p in paths],ignore_index=True)).drop_duplicates(['race_id','horse_number'],keep='last')
    d=d.loc[d.finish_position.notna()].sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)
    d['race_date']=pd.to_datetime(d.race_date).dt.strftime('%Y-%m-%d')
    for c in ['horse_id','jockey_id','trainer_id']:d[c]=d[c].astype(str).str.lstrip('0').replace('','0')
    print('NAR rows',len(d),'races',d.race_id.nunique(),flush=True)
    modes=inputs_by_mode(prior_features(d),d.race_id)
    f=pd.DataFrame(modes['hybrid'],columns=[f'prior_{i}' for i in range(56)])
    for col in ['racecourse','surface','going']:
        f[col]=d[col].fillna('__missing__').astype('category')
    for col in ['distance_m','gate','horse_number','age','weight_carried','horse_weight','horse_weight_change']:
        if col in d:f[col]=pd.to_numeric(d[col],errors='coerce')
    f['field_size']=d.groupby('race_id').race_id.transform('size')
    train=d.race_date.lt('2025-01-01').to_numpy()
    frozen=json.loads((ROOT/'reports/rein-eight-year-frozen-nar.json').read_text())['live_model']
    baseline={}
    for target,role in enumerate(ROLES,1):
        recipe=frozen['roles'][str(target)];mode=recipe['mode'];m=fit(modes[mode][train],d.finish_position.eq(target).to_numpy()[train])
        s=predict(m,modes[mode]);conditional=frozen.get('conditionalRoles',{}).get(str(target))
        if conditional:
            local=local_models(d,modes[mode],d.finish_position.eq(target).to_numpy(),train,conditional['kind'],m)
            s=conditioned_predict(d,modes[mode],m,local,conditional['kind'])
        # Sigmoid is monotone and normalization doesn't affect within-race rank.
        baseline[role]=1/(1+np.exp(-np.clip(s,-40,40)))
    return d,f,baseline


def jra_dataset():
    from rein_eight_year_recall import jra_predictions
    cache=ROOT/'.second-third-audit/jra/current-role-predictions.parquet'
    d=(pd.read_parquet(cache) if cache.exists() else jra_predictions()).reset_index(drop=True)
    f=pd.read_parquet(ROOT/'.second-third-audit/jra/batch-features.parquet').reset_index(drop=True)
    d['race_date']=pd.to_datetime(d.race_date).dt.strftime('%Y-%m-%d')
    # Keep only inputs computed by deployed full-frame implementation.
    schema=json.loads(next((ROOT/'.second-third-audit/jra').glob('*/schema.json')).read_text())
    second=json.loads((ROOT/'rein-web/api/models/second_joint_v5.schema.json').read_text())
    columns=list(dict.fromkeys(schema['feature_order']+schema['role_feature_order']['third']+second['feature_order']))
    # Deployed first-model legacy adapter treats an unchanged body weight as NaN.
    # New candidates use the full frame where zero is retained.
    legacy=f[schema['feature_order']].copy()
    legacy['horse_weight_change']=legacy.horse_weight_change.replace(0,np.nan)
    root=next((ROOT/'.second-third-audit/jra').glob('*/schema.json')).parent
    d['first']=lgb.Booster(model_file=str(root/'models/first.txt')).predict(legacy,num_threads=2)
    return d,f[columns],{role:d[role].to_numpy() for role in ROLES}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--league',choices=['jra','nar'],required=True);parser.add_argument('--output-dir',type=Path,required=True);parser.add_argument('--reuse-candidates',action='store_true');args=parser.parse_args()
    d,f,base=jra_dataset() if args.league=='jra' else nar_dataset()
    d['distance_band']=np.where(d.distance_m<1400,'short',np.where(d.distance_m<=1800,'mile','long'))
    train=d.race_date.lt('2025-01-01').to_numpy();eligible=d.race_date.ge('2025-01-01').to_numpy()
    args.output_dir.mkdir(parents=True,exist_ok=True)
    report={'league':args.league,'training':'2019-2024 only','selection':'2025H1','confirmation':'2025H2','audit':'2026 retrospective; previously inspected','uses_current_odds_as_input':False,'scope':'new research, not production activation','coverage':{'rows':len(d),'races':int(d.race_id.nunique()),'last_date':str(d.race_date.max())},'baseline':'JRA frozen deployed models; NAR deployed recipe refitted ONLY on 2019-2024 to avoid in-sample evaluation of deployed all-data refit','gate':'positive paired date-cluster Top5 CI in both H2 and 2026; no pop4plus or Top3 deterioration; serving parity and prospective shadow still required','roles':{}}
    configs={'binary-small':dict(n_estimators=280,num_leaves=7,min_child_samples=400,reg_lambda=15),'binary-medium':dict(n_estimators=400,num_leaves=15,min_child_samples=400,reg_lambda=15)}
    for target,role in enumerate(ROLES,1):
        predictions={'current_recipe':base[role], 'popularity':-pd.to_numeric(d.popularity,errors='coerce').fillna(999).to_numpy()}
        y=d.finish_position.eq(target).astype(int)
        for name,cfg in configs.items():
            print('TRAIN',args.league,role,name,flush=True)
            path=args.output_dir/f'{role}-{name}.txt'
            if args.reuse_candidates and path.exists():
                booster=lgb.Booster(model_file=str(path))
                if booster.feature_name()!=list(f.columns):raise ValueError('Cached candidate input mismatch')
                predictions[name]=booster.predict(f,num_threads=2)
            else:
                model=lgb.LGBMClassifier(**cfg,learning_rate=.03,n_jobs=2,verbosity=-1,random_state=20261005,max_bin=127)
                model.fit(f.loc[train],y.loc[train]);predictions[name]=model.predict_proba(f)[:,1]
                model.booster_.save_model(str(path))
            for weight in [.25,.5]:
                a=predictions[name];b=base[role]
                aa=a/pd.Series(a).groupby(d.race_id).transform('sum').to_numpy();bb=b/pd.Series(b).groupby(d.race_id).transform('sum').to_numpy()
                predictions[f'{name}-blend-{weight}']=(1-weight)*bb+weight*aa
        if args.league=='jra':
            print('TRAIN',args.league,role,'rank-top5',flush=True)
            path=args.output_dir/f'{role}-rank-top5.txt'
            if args.reuse_candidates and path.exists():
                ranker=lgb.Booster(model_file=str(path))
                if ranker.feature_name()!=list(f.columns):raise ValueError('Cached ranker input mismatch')
            else:
                ordered=d.loc[train].race_id.to_numpy()
                groups=d.loc[train].groupby('race_id',sort=False).size().to_numpy()
                if len(np.unique(ordered))!=len(groups) or not np.array_equal(ordered,np.repeat(d.loc[train].race_id.drop_duplicates().to_numpy(),groups)):
                    raise ValueError('Ranking rows must be contiguous per race')
                fitted=lgb.LGBMRanker(n_estimators=400,num_leaves=15,min_child_samples=300,reg_lambda=15,learning_rate=.03,n_jobs=2,verbosity=-1,random_state=20261005,max_bin=127,lambdarank_truncation_level=6)
                fitted.fit(f.loc[train],y.loc[train],group=groups)
                ranker=fitted.booster_;ranker.save_model(str(path))
            score=ranker.predict(f,num_threads=2)
            predictions['rank-top5']=score
            ar=ranks(d,score).to_numpy();br=ranks(d,base[role]).to_numpy()
            for weight in [.25,.5]:predictions[f'rank-top5-blend-{weight}']=-((1-weight)*br+weight*ar)
        result=evaluate(d.loc[eligible].reset_index(drop=True),{name:np.asarray(values)[eligible] for name,values in predictions.items()},target)
        report['roles'][role]=result
        (args.output_dir/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print('RESULT',role,result['selected'],result['gate'],json.dumps(result['comparisons']['retrospective2026']),flush=True)
    (args.output_dir/'feature-order.json').write_text(json.dumps(list(f.columns)))

if __name__=='__main__':main()
