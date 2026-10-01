"""Research only: exact third-place recall after adding second-place support.

Select using 2025, audit frozen choices using 2026. No production writes.
"""
from pathlib import Path
import sys, json, gzip
import numpy as np
import pandas as pd
import lightgbm as lgb
import argparse

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'src'), str(ROOT / 'rein-web/api')]

def live_identifiers(f, rows, raw):
    keys = ['race_id', 'horse_number']
    ids = rows[keys].merge(raw[keys + ['jockey_id','trainer_id']], on=keys, how='left', validate='one_to_one')
    for col in ('jockey_id','trainer_id'):
        f[col] = pd.Series(ids[col].astype(str).str.lstrip('0').replace('', '0').to_numpy(), index=f.index).astype('category')
    return f

def align_live_rates(f, rows, raw):
    h=raw.loc[~raw.finish_status.astype(str).str.contains('取消|除外')].copy()
    h['race_date']=pd.to_datetime(h.race_date)
    h=h.sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)
    for col in ('horse_id','jockey_id','trainer_id'):
        h[col]=h[col].astype(str).str.lstrip('0').replace('', '0')
    valid=h.finish_position.notna().astype(int);placed=h.finish_position.between(1,3).astype(int)
    wet=h.going.isin(['重','不良'])
    n=valid.groupby([h.horse_id,wet]).cumsum()-valid
    t=placed.groupby([h.horse_id,wet]).cumsum()-placed
    h['horse_wet_prior_starts']=n
    h['horse_wet_prior_top3_rate']=(t+4.5)/(n+20)
    for entity in ('jockey_id','trainer_id'):
        daily=pd.DataFrame({'entity':h[entity],'date':h.race_date,'n':1,'w':h.finish_position.eq(1).astype(int),'t':placed}).groupby(['entity','date']).sum().reset_index()
        lookup=[]
        for key,g in daily.groupby('entity',sort=False):
            g=g.set_index('date').sort_index();z=g[['n','w','t']].rolling('90D',closed='left').sum();z['entity']=key;lookup.append(z.reset_index())
        z=pd.concat(lookup).set_index(['entity','date']);q=z.reindex(pd.MultiIndex.from_arrays([h[entity],h.race_date])).fillna(0)
        h[entity+'_recent90_win']=((q.w+1.5)/(q.n+20)).to_numpy()
        h[entity+'_recent90_place']=((q.t+4.5)/(q.n+20)).to_numpy()
    cols=['horse_wet_prior_starts','horse_wet_prior_top3_rate']+[e+'_recent90_'+t for e in ('jockey_id','trainer_id') for t in ('win','place')]
    z=rows[['race_id','horse_number']].merge(h[['race_id','horse_number']+cols],on=['race_id','horse_number'],validate='one_to_one')
    for col in cols:f[col]=z[col].to_numpy()
    return f

def jra_predictions():
    from rein_research import prepare
    from rein_research_v3 import add_v3_features
    from baken_academia.features import build_feature_frame
    root = next((ROOT / '.second-third-audit/jra').glob('*/schema.json')).parent
    cache = ROOT / '.second-third-audit/jra/current-role-predictions.parquet'
    if cache.exists() and (cache.parent/'batch-features.parquet').exists():
        out = pd.read_parquet(cache)
        f = pd.read_parquet(cache.parent/'batch-features.parquet')
        # Live runtime strips leading zeroes in rider/trainer identifiers.
        # Match it rather than quietly evaluating a training-only feature path.
        raw = pd.read_parquet(root/'data/history.parquet')
        f = align_live_rates(live_identifiers(f, out, raw), out, raw)
        schema = json.loads((root/'schema.json').read_text())
        ss = json.loads((ROOT/'rein-web/api/models/second_joint_v5.schema.json').read_text())
        with gzip.open(ROOT/'rein-web/api/models/second_joint_v5.txt.gz','rt') as stream:
            second = lgb.Booster(model_str=stream.read())
        third = lgb.Booster(model_file=str(root/'models/third.txt'))
        out['second'] = second.predict(f[ss['feature_order']],num_threads=2)[:,ss['second_class_index']]
        out['third'] = third.predict(f[schema['role_feature_order']['third']],num_threads=2)
        f.to_parquet(cache.parent/'batch-features.parquet',index=False)
        out.to_parquet(cache,index=False)
        return out
    raw = pd.read_parquet(root / 'data/history.parquet')
    print('JRA historical features', len(raw), flush=True)
    x, added = add_v3_features(prepare(raw))
    base, _, _ = build_feature_frame(x)
    extra = list(dict.fromkeys([c for c in x if c.startswith(('prior_', 'recent3_')) or '_recent90_' in c] + ['expected_front_count', 'relative_early'] + added))
    f = pd.concat([base, x[extra]], axis=1)
    group = x.groupby('horse_id', observed=True, sort=False)
    # Match live means over the last N starts, including a missing finish as a
    # non-hit for exact-place rates. Windows exclude the current start.
    for position in (1, 2, 3):
        shifted = x.finish_position.eq(position).astype(float).groupby(x.horse_id).shift()
        for window in (5, 10):
            f[f'history_exact_{position}_last{window}'] = shifted.groupby(x.horse_id).rolling(window, min_periods=1).mean().reset_index(level=0, drop=True).reindex(x.index)
    for col in ('recent3_speed_relative', 'recent3_closing3f_z', 'horse_win_rate', 'horse_top3_rate', 'horse_recent5_avg_finish', 'recent3_result_strength'):
        f[col + '_field_rank'] = f[col].groupby(x.race_id).rank(pct=True)
        f[col + '_field_gap'] = f[col] - f[col].groupby(x.race_id).transform('mean')
    wet = x.going.isin(['重', '不良']).astype(int)
    placed = x.finish_position.between(1, 3).astype(float)
    g = x.groupby([x.horse_id, wet], observed=True, dropna=False)
    n = g.cumcount().astype(float)
    f['horse_wet_prior_starts'] = n
    f['horse_wet_prior_top3_rate'] = (placed.groupby([x.horse_id, wet]).cumsum() - placed + 4.5) / (n + 20)
    schema = json.loads((root / 'schema.json').read_text())
    second_schema = json.loads((ROOT / 'rein-web/api/models/second_joint_v5.schema.json').read_text())
    with gzip.open(ROOT / 'rein-web/api/models/second_joint_v5.txt.gz', 'rt') as stream:
        second = lgb.Booster(model_str=stream.read())
    third = lgb.Booster(model_file=str(root / 'models/third.txt'))
    mask = x.surface.isin(['芝', 'ダート'])
    out = x.loc[mask, ['race_id','horse_number','race_date','racecourse','distance_m','going','popularity','finish_position']].copy()
    f = align_live_rates(live_identifiers(f, x, raw), x, raw)
    sf = f.loc[mask, second_schema['feature_order']]
    tf = f.loc[mask, schema['role_feature_order']['third']]
    print('Predict current JRA models', len(out), flush=True)
    f.loc[mask].to_parquet(cache.parent/'batch-features.parquet',index=False)
    out['first'] = lgb.Booster(model_file=str(root / 'models/first.txt')).predict(f.loc[mask, schema['role_feature_order']['first']], num_threads=2)
    out['second'] = second.predict(sf, num_threads=2)[:,second_schema['second_class_index']]
    out['third'] = third.predict(tf, num_threads=2)
    out.to_parquet(cache,index=False)
    return out

def nar_predictions(input_dir):
    from nar_live_model import normalize_courses, prior_features, inputs_by_mode
    from nar_condition_validation import fit, predict, local_models, conditioned_predict
    paths=sorted(Path(input_dir).rglob('nar-*.parquet'))
    paths=[p for p in paths if not any(t in p.name for t in ('-odds-','-payouts','-manifest'))]
    if not paths: raise ValueError('No NAR historical input')
    data=normalize_courses(pd.concat([pd.read_parquet(p) for p in paths],ignore_index=True))
    data=data.drop_duplicates(['race_id','horse_number'],keep='last')
    data=data.loc[data.finish_position.notna()].sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)
    data['race_date']=pd.to_datetime(data.race_date).dt.strftime('%Y-%m-%d')
    print('NAR historical features',len(data),data.race_id.nunique(),flush=True)
    features=inputs_by_mode(prior_features(data),data.race_id)['hybrid']
    train=data.race_date.lt('2025-01-01').to_numpy()
    for target,role in ((2,'second'),(3,'third')):
        y=data.finish_position.eq(target).to_numpy()
        model=fit(features[train],y[train])
        scores=predict(model,features)
        if target==2:
            # Replay the venue correction already adopted by the previous audit.
            models=local_models(data,features,y,train,'course',model)
            scores=conditioned_predict(data,features,model,models,'course')
        # Candidate blends use positive odds scores; monotonic conversion leaves
        # the current and rank-blend orders unchanged. These are ranking weights,
        # not calibrated probabilities or the published sigmoid-share scale.
        data[role]=np.exp(scores-pd.Series(scores).groupby(data.race_id).transform('max'))
    return data.loc[data.race_date.ge('2025-01-01'),['race_id','horse_number','race_date','racecourse','distance_m','going','popularity','finish_position','second','third']]

def ranks(data, scores):
    q = pd.DataFrame({'race': data.race_id, 'horse':data.horse_number, 'score':np.asarray(scores)}, index=data.index)
    q = q.sort_values(['race','score','horse'],ascending=[True,False,True],kind='stable')
    return (q.groupby('race',sort=False).cumcount()+1).reindex(data.index)

def candidates(data):
    s = data.second / data.second.groupby(data.race_id).transform('sum')
    t = data.third / data.third.groupby(data.race_id).transform('sum')
    r2, r3 = ranks(data,s), ranks(data,t)
    size = data.groupby('race_id').race_id.transform('size')
    result = {'current':t}
    for w in (.1,.2,.3,.5,.7,1.):
        result[f'blend-{w}'] = (1-w)*t+w*s
    for w in (.1,.2,.3,.5,.7):
        result[f'rank-blend-{w}'] = -((1-w)*r3+w*r2)/size
    for top in (2,3,5):
        for w in (.25,.5,1.):
            result[f'support-top{top}-{w}'] = t+w*(s-t).clip(lower=0)*r2.le(top)*r3.gt(5)
        for bonus in (1.,2.,3.):
            result[f'rank-lift-top{top}-{bonus}'] = -r3+bonus*r2.le(top)*r3.gt(5)
    return result

def metrics(data, score):
    r = ranks(data,score)
    actual = data.loc[data.finish_position.eq(3)]
    actual = actual.loc[actual.groupby('race_id').race_id.transform('size').eq(1)]
    result={}
    for name,mask in [('all',pd.Series(True,index=actual.index)),('pop4plus',actual.popularity.ge(4)),('pop10plus',actual.popularity.ge(10)),('field6plus',actual.race_id.map(data.groupby('race_id').size()).gt(5))]:
        a=actual.loc[mask]
        result[name]={'races':len(a),**{f'top{k}':{'hits':int(r.loc[a.index].le(k).sum()),'rate':float(r.loc[a.index].le(k).mean()) if len(a) else None} for k in (1,3,5)}}
    return result

def paired(data,a,b):
    actual=data.loc[data.finish_position.eq(3)]
    actual=actual.loc[actual.groupby('race_id').race_id.transform('size').eq(1)]
    aa=ranks(data,a).loc[actual.index].le(5);bb=ranks(data,b).loc[actual.index].le(5)
    diff=aa.astype(int)-bb.astype(int)
    daily=pd.DataFrame({'d':diff,'date':actual.race_date}).groupby('date').d.agg(['sum','count']).to_numpy()
    ci=None
    if len(daily)>=30:
        rng=np.random.default_rng(20261001);idx=rng.integers(len(daily),size=(2000,len(daily)));v=daily[idx].sum(axis=1)
        ci=np.quantile(v[:,0]/v[:,1],[.025,.975]).tolist()
    return {'rescued':int((aa&~bb).sum()),'lost':int((~aa&bb).sum()),'net':int(diff.sum()),'gain':float(diff.mean()),'date_cluster_95ci':ci,'dates':len(daily)}

def evaluate(data):
    data=data.sort_values(['race_id','horse_number']).reset_index(drop=True)
    scores=candidates(data)
    select=data.race_date.between('2025-01-01','2025-12-31')
    test=data.race_date.ge('2026-01-01')
    grid={name:metrics(data.loc[select],s.loc[select]) for name,s in scores.items()}
    def key(name):
        z=grid[name]['all'];return (z['top5']['hits'],z['top3']['hits'],z['top1']['hits'], name=='current')
    selected=max(grid,key=key)
    constrained=[n for n in scores if n=='current' or n.startswith(('support-','rank-lift-'))]
    conditional=max(constrained,key=key)
    guarded = [n for n in scores if all(grid[n][s]['top5']['hits'] >= grid['current'][s]['top5']['hits'] for s in ('pop4plus','pop10plus'))]
    guarded_selected = max(guarded,key=key)
    report={'selected':selected,'selectedConditional':conditional,'selectedPopularityGuarded':guarded_selected,'selection':grid,'audit':{},'comparisons':{},'byCourse':{}}
    for name in dict.fromkeys(['current',selected,conditional,guarded_selected,'blend-0.2','blend-0.5']):
        report['audit'][name]=metrics(data.loc[test],scores[name].loc[test])
        report['comparisons'][name]=paired(data.loc[test],scores[name].loc[test],scores['current'].loc[test])
    for course,g in data.loc[test].groupby('racecourse'):
        report['byCourse'][course]={'current':metrics(g,scores['current'].loc[g.index]),'selected':metrics(g,scores[selected].loc[g.index]),'paired':paired(g,scores[selected].loc[g.index],scores['current'].loc[g.index])}
    return report


def summary(data, league):
    result={'coverage':{'races':int(data.race_id.nunique()),'rows':len(data),'from':str(data.race_date.min()),'to':str(data.race_date.max())},'periods':{}}
    for period,mask in [('all',pd.Series(True,index=data.index)),('2019-2024',data.race_date.lt('2025-01-01')),('2025',data.race_date.between('2025-01-01','2025-12-31')),('2026',data.race_date.ge('2026-01-01'))]:
        d=data.loc[mask]; result['periods'][period]={}
        for target,role in enumerate(('first','second','third'),1):
            rr=ranks(d,d[role]); a=d.loc[d.finish_position.eq(target)]
            a=a.loc[a.groupby('race_id').race_id.transform('size').eq(1)]
            result['periods'][period][str(target)]={'races':len(a),'excluded_tied_or_missing':int(d.race_id.nunique()-len(a)),**{f'top{k}':{'hits':int(rr.loc[a.index].le(k).sum()),'rate':float(rr.loc[a.index].le(k).mean()) if len(a) else None} for k in (3,4,5)}}
    return result

def full_nar():
    from nar_live_model import normalize_courses,prior_features,inputs_by_mode
    frozen=json.loads(Path('reports/rein-eight-year-frozen-nar.json').read_text())
    paths=[p for p in Path('.nar-dataset').rglob('nar-*.parquet') if not any(t in p.name for t in ('-odds-','-payouts','-manifest'))]
    d=normalize_courses(pd.concat([pd.read_parquet(p) for p in paths],ignore_index=True)).drop_duplicates(['race_id','horse_number'],keep='last')
    d=d.loc[d.finish_position.notna()].sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)
    d['race_date']=pd.to_datetime(d.race_date).dt.strftime('%Y-%m-%d')
    for c in ('horse_id','jockey_id','trainer_id'): d[c]=d[c].astype(str).str.lstrip('0').replace('','0')
    xs=inputs_by_mode(prior_features(d),d.race_id);model=frozen['live_model']
    for target,role in enumerate(('first','second','third'),1):
        m=model['roles'][str(target)];scores=m['intercept']+xs[m['mode']]@np.array(m['coef'])
        conditional=model.get('conditionalRoles',{}).get(str(target))
        if conditional:
            assert conditional['kind']=='course'
            keys=d.racecourse.astype(str)+'|'+d.surface.astype(str)
            for key,local in conditional['models'].items():
                mask=keys.eq(key).to_numpy()
                scores[mask]=local['intercept']+xs['hybrid'][mask]@np.array(local['coef'])
        d[role]=scores
    return d

if __name__=='__main__':
    out=Path('artifacts/rein-eight-year');out.mkdir(parents=True,exist_ok=True)
    report={'definition':'exact finishing horse in suitability Top3/4/5; tied target finishes excluded','method':'frozen current models; date-prior historical features; all-years includes model training data and is not out-of-sample','jra_model_bundle':'f09ba60f2141dda639c667423b1a07eec73eb0dc','nar_release':json.loads(Path('reports/rein-eight-year-frozen-nar.json').read_text())['live_model']['release']}
    j=jra_predictions();j['race_date']=pd.to_datetime(j.race_date).dt.strftime('%Y-%m-%d')
    report['JRA']=summary(j,'JRA');print('JRA',json.dumps(report['JRA']),flush=True)
    n=full_nar();report['NAR']=summary(n,'NAR')
    report['combined']={}
    for period in report['JRA']['periods']:
        report['combined'][period]={}
        for role in ('1','2','3'):
            a=report['JRA']['periods'][period][role];b=report['NAR']['periods'][period][role];den=a['races']+b['races']
            report['combined'][period][role]={'races':den,**{f'top{k}':{'hits':a[f'top{k}']['hits']+b[f'top{k}']['hits'],'rate':(a[f'top{k}']['hits']+b[f'top{k}']['hits'])/den} for k in (3,4,5)}}
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False),flush=True)
