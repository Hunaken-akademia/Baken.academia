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
        f = live_identifiers(f, out, raw)
        schema = json.loads((root/'schema.json').read_text())
        ss = json.loads((ROOT/'rein-web/api/models/second_joint_v5.schema.json').read_text())
        with gzip.open(ROOT/'rein-web/api/models/second_joint_v5.txt.gz','rt') as stream:
            second = lgb.Booster(model_str=stream.read())
        third = lgb.Booster(model_file=str(root/'models/third.txt'))
        out['second'] = second.predict(f[ss['feature_order']],num_threads=2)[:,ss['second_class_index']]
        out['third'] = third.predict(f[schema['role_feature_order']['third']],num_threads=2)
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
    mask = x.race_date.ge('2025-01-01') & x.surface.isin(['芝', 'ダート'])
    out = x.loc[mask, ['race_id','horse_number','race_date','racecourse','distance_m','going','popularity','finish_position']].copy()
    f = live_identifiers(f, x, raw)
    sf = f.loc[mask, second_schema['feature_order']]
    tf = f.loc[mask, schema['role_feature_order']['third']]
    print('Predict current JRA models', len(out), flush=True)
    f.loc[mask].to_parquet(cache.parent/'batch-features.parquet',index=False)
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

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--league',choices=['jra','nar'],default='jra');p.add_argument('--input-dir');p.add_argument('--output-dir',default=str(ROOT/'.second-third-audit/report'));args=p.parse_args()
    out=Path(args.output_dir);out.mkdir(parents=True,exist_ok=True)
    data=jra_predictions() if args.league=='jra' else nar_predictions(args.input_dir)
    r=evaluate(data);r['coverage']={'rows':len(data),'races':int(data.race_id.nunique()),'from':str(data.race_date.min()),'to':str(data.race_date.max())};(out/f'{args.league}.json').write_text(json.dumps(r,ensure_ascii=False,indent=2))
    print(json.dumps({k:r[k] for k in ('selected','selectedConditional','audit','comparisons')},ensure_ascii=False),flush=True)
