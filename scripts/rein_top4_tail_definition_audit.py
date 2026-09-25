"""Fixed-policy retrospective audit; no fitting, production writes or source-site requests.
Do NOT call the real-odds research 70/30 blend the deployed production model.
"""
from pathlib import Path
import json
import os
import hashlib
import numpy as np
import pandas as pd

ROLES = ('first', 'second', 'third')
W = np.array([.5,.3,.2])

def splice(head, tail):
    chosen = set(head[:4])
    return np.r_[head[:4], [v for v in tail if v not in chosen]].astype(int)

def paired_interval(a, b, dates):
    _, days = np.unique(dates, return_inverse=True)
    ns = np.bincount(days)
    delta = np.bincount(days, weights=a.astype(int)-b.astype(int))
    rng = np.random.default_rng(20260926)
    ix = rng.integers(len(ns), size=(4000, len(ns)))
    draws = 100*delta[ix].sum(axis=1)/ns[ix].sum(axis=1)
    return {'difference_pp':float(100*(a.mean()-b.mean())),
            'ci95_day_cluster_pp':np.quantile(draws,[.025,.975]).tolist(),
            'gained_races':int((a & ~b).sum()),'lost_races':int((~a & b).sum())}

def main():
    frames=[]
    provenance={}
    for role in ROLES:
        path=Path('.new')/role/'predictions.parquet'
        provenance[role]=hashlib.sha256(path.read_bytes()).hexdigest()
        p=pd.read_parquet(path)
        p['race_id']=p.race_id.astype(str)
        base=['race_id','horse_number','race_date','popularity','finish_numeric']
        f=p[base+['real_odds_market','real_odds_without_people']].rename(columns={
            'real_odds_market':role+'_m','real_odds_without_people':role+'_r'})
        frames.append(f)
    x=frames[0]
    keys=['race_id','horse_number']
    for f in frames[1:]:
        assert x[keys+['popularity','finish_numeric']].equals(f[keys+['popularity','finish_numeric']])
        x=x.merge(f[keys+[c for c in f if c.endswith(('_m','_r'))]],on=keys,validate='one_to_one')
    old_path=Path('.old/frozen_predictions.csv.gz')
    old=pd.read_csv(old_path)
    old['race_id']=old.race_id.astype(str)
    provenance['frozen_production']=hashlib.sha256(old_path.read_bytes()).hexdigest()
    old=old.rename(columns={'popularity':'old_popularity','finish_numeric':'old_finish'})
    x=x.merge(old[keys+['old_popularity','old_finish','p_first','p_second','p_third']],on=keys,how='left',validate='one_to_one')
    assert x['popularity'].eq(x['old_popularity']).all()
    assert np.allclose(x.finish_numeric,x.old_finish,equal_nan=True)
    assert np.isfinite(x[['p_first','p_second','p_third']]).all().all()
    x['race_date']=pd.to_datetime(x.race_date)
    methods=['popularity','production_current','research_70_30','market_difference','top4_new_tail_research','top4_new_tail_production','original_top4_reordered']
    hit={k:[] for k in methods}; rows=[]; meta=[]; checks=0
    for rid,g in x.groupby('race_id',observed=True,sort=False):
        g=g.sort_values('horse_number')
        n=len(g); assert n>5
        pop=g.popularity.to_numpy(float);numbers=g.horse_number.to_numpy(int)
        actual=np.flatnonzero(g.finish_numeric.eq(1)); assert len(actual)==1
        actual=int(actual[0])
        def order(v): return np.lexsort((numbers,pop,-v))
        market=g[[r+'_m' for r in ROLES]].to_numpy(float)
        rein=g[[r+'_r' for r in ROLES]].to_numpy(float)
        m=market@W;r=rein@W
        research=.7*m+.3*r
        edge=np.log((rein+1e-12)/(market+1e-12))@W
        edge_score=m*np.exp(.75*edge)
        prod=g[['p_first','p_second','p_third']].to_numpy(float)
        prod=prod/prod.sum(axis=0)
        pm=1/pop;pm=pm/pm.sum()
        prod_score=np.floor(np.clip(50+(.7*pm+.3*(prod@W))*n*35,45,98)+.5)
        base=order(prod_score);rb=order(research);eo=order(edge_score)
        # Secondary interpretation: keep original Top4 members and only reorder inside them.
        rehead=np.array([i for i in eo if i in set(base[:4])])
        orders={'popularity':np.lexsort((numbers,pop)),'production_current':base,
                'research_70_30':rb,'market_difference':eo,
                'top4_new_tail_research':splice(eo,rb),
                'top4_new_tail_production':splice(eo,base),
                'original_top4_reordered':np.r_[rehead,base[4:]]}
        for name,idx in orders.items():
            assert sorted(idx.tolist())==list(range(n))
            rank=int(np.flatnonzero(idx==actual)[0])+1
            hit[name].append([rank<=k for k in range(1,9)])
            if name.startswith('top4_new_tail_'):
                assert np.array_equal(idx[:4],eo[:4])
                tail_base=rb if name.endswith('research') else base
                assert idx[4:].tolist()==[v for v in tail_base if v not in set(eo[:4])]
                checks+=1
            rows.append({'race_id':str(rid),'method':name,'winner_rank':rank,'order':','.join(map(str,numbers[idx]))})
        meta.append({'race_id':str(rid),'date':str(g.race_date.iloc[0].date()),'runners':n})
    meta=pd.DataFrame(meta);date=meta.date.to_numpy()
    hit={k:np.array(v,bool) for k,v in hit.items()}
    masks={'selection_2025H1':date<'2025-07-01',
           'confirmation_2025H2':(date>='2025-07-01')&(date<'2026-01-01'),
           'audit_2026':date>='2026-01-01'}
    report={'policy':'take full-field market-difference Top4; append remaining runners in baseline order, without duplicates',
       'production_changed':False,'fitting_performed':False,'new_policy_chosen_after_previous_audits':True,
       'production_definition':'0.7*normalized_inverse_popularity + 0.3*(0.5*old_first+0.3*old_second+0.2*old_third), then 45..98 clamp and half-up integer score; ties by popularity',
       'production_route_blob':'8d786e37f23c8420b5158f79346dba207eeb4ea0',
       'research_baseline_definition':'0.7*(.5*new_market_first+.3*new_market_second+.2*new_market_third)+0.3*(.5*new_REIN_first+.3*new_REIN_second+.2*new_REIN_third)',
       'limitations':['final historical win odds, not pre-race snapshots','2025H2 and 2026 previously inspected; retrospective, not untouched validation','original model scores reconstructed for successful inference; no inference-fallback scenario','intervals do not correct repeated exploration; not ROI or ticket-hit metrics'],
       'source_commit':os.environ.get('GITHUB_SHA'),'data_sha256':provenance,'periods':{},'checks':{'top4_tail_invariants':checks,'races':len(meta)}}
    for period,mask in masks.items():
        report['periods'][period]={}
        for name,a in hit.items():
            vals=a[mask];n=len(vals)
            report['periods'][period][name]={'races':n,'hits':vals.sum(axis=0).astype(int).tolist(),'rates':vals.mean(axis=0).tolist()}
        for name,base in [('top4_new_tail_research','research_70_30'),('top4_new_tail_production','production_current'),('original_top4_reordered','production_current')]:
            report['periods'][period][name]['versus_baseline']={str(k):paired_interval(hit[name][mask,k-1],hit[base][mask,k-1],date[mask]) for k in range(1,9)}
    # Frozen reference metrics catch cohort, sorting, or baseline-definition drift.
    assert report['periods']['audit_2026']['research_70_30']['hits'][:5]==[807,1274,1569,1795,1961]
    assert report['periods']['audit_2026']['market_difference']['hits'][:5]==[816,1277,1576,1797,1959]
    assert report['periods']['audit_2026']['production_current']['hits'][:5]==[810,1267,1569,1792,1942]
    assert report['periods']['audit_2026']['top4_new_tail_research']['hits'][4]==1961
    assert report['periods']['confirmation_2025H2']['top4_new_tail_research']['hits'][4]==1349
    out=Path('artifacts/top4-tail-definition');out.mkdir(parents=True,exist_ok=True)
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False))
    pd.DataFrame(rows).to_csv(out/'rank_orders.csv.gz',index=False,compression='gzip')
    meta.to_csv(out/'races.csv',index=False)
    summary={period:{name:d['hits'][:5] for name,d in group.items()} for period,group in report['periods'].items()}
    print(json.dumps(summary,ensure_ascii=False,indent=2),flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        Path(os.environ['GITHUB_STEP_SUMMARY']).write_text('Top4 splice audit; no production change\n\n```json\n'+json.dumps(summary,ensure_ascii=False,indent=2)+'\n```\n')

if __name__=='__main__': main()
