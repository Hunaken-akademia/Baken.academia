import numpy as np
import pandas as pd
from scripts.rein_accuracy_experiments import evaluate, metrics, ranks


def fixture():
    rows=[]
    for period in ['2025-01-01','2025-07-01','2026-01-01']:
        for day in range(40):
            date=(pd.Timestamp(period)+pd.Timedelta(days=day)).strftime('%Y-%m-%d')
            for h in range(1,9):
                rows.append(dict(race_id=f'{date}-1',horse_number=h,race_date=date,popularity=h,finish_position=h,racecourse='test',surface='dirt',going='good',distance_band='mile'))
    return pd.DataFrame(rows)


def test_exact_target_excludes_ties_and_does_not_pool_top_three():
    d=fixture().iloc[:8].copy()
    score=np.array([8,7,6,5,4,3,2,1])
    z=metrics(d,score,2)
    assert z['all']['top1']['hits']==0
    assert z['all']['top3']['hits']==1
    d.loc[d.horse_number.eq(3),'finish_position']=2
    assert metrics(d,score,2)['all']['races']==0


def test_candidate_selection_uses_h1_and_fails_when_later_periods_regress():
    d=fixture()
    d.loc[d.horse_number.eq(1),'finish_position']=6
    d.loc[d.horse_number.eq(6),'finish_position']=1
    base=-np.tile(np.arange(1,9),len(d)//8)
    improved=-base.copy()
    mixed=np.where(d.race_date.le('2025-06-30'),improved,base)
    out=evaluate(d,dict(current_recipe=base,popularity=improved,candidate=mixed),1)
    assert out['selected']=='candidate'
    assert out['gate']=='keep_current'
    changed=evaluate(d,dict(current_recipe=base,popularity=improved,candidate=np.where(d.race_date.le('2025-06-30'),improved,improved)),1)
    assert changed['selected']==out['selected']
    assert changed['gate']=='offline_pass'


def test_small_samples_do_not_pass_confidence_gate():
    d=fixture().iloc[:8].copy()
    out=evaluate(d,dict(current_recipe=np.arange(8),candidate=-np.arange(8),popularity=-np.arange(8)),1)
    assert out['gate']=='keep_current'


def test_ranks_preserve_rows_and_break_ties_deterministically():
    d=fixture().iloc[:8].sample(frac=1,random_state=1)
    rr=ranks(d,np.ones(len(d)))
    assert list(rr.index)==list(d.index)
    assert np.array_equal(rr.to_numpy(),d.horse_number.to_numpy())


def test_shared_candidate_is_measured_even_when_one_role_ties_baseline_in_h1():
    d=fixture()
    base=-np.tile(np.arange(1,9),len(d)//8)
    shared=np.where(d.race_date.le('2025-06-30'),base,-base)
    predictions=dict(current_recipe=base,shared=shared,popularity=base)
    assert evaluate(d,predictions,1)['selected']=='current_recipe'
    forced=evaluate(d,predictions,1,forced='shared')
    assert forced['selected']=='shared'
    assert forced['comparisons']['confirmation2025H2']['all']['net']<0
    assert forced['gate']=='keep_current'
