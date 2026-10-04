import gzip,json,sys
from pathlib import Path
import pandas as pd
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from refresh_nar_profile import GROUPS,append,profile
from baken_academia.rein_history import build


def rows(day,finishes):
    return pd.DataFrame([dict(race_date=day,race_id=f'{day}-1',horse_number=i+1,horse_id=f'2020{i}',jockey_id=f'010{i}',trainer_id=f'020{i}',surface='ダート',racecourse='金沢',baba_code=22,distance_m=1400,going='良',gate=i+1,finish_position=f) for i,f in enumerate(finishes)])


def blank():
    return dict(schema=1,meta=dict(races=0,runners=0,horses=0),counts={k:{} for k in GROUPS},recent={})


def test_incremental_exact_counts_equal_full_rebuild_including_last_five(tmp_path):
    days=[rows(f'2026-09-{20+i:02d}',[1 if i%2==0 else 4,2,3]) for i in range(7)]
    state=blank()
    for d in days:append(state,d)
    path=tmp_path/'rows.parquet';pd.concat(days,ignore_index=True).to_parquet(path,index=False)
    output=tmp_path/'profile.gz';build(path,output)
    expected=json.loads(gzip.decompress(output.read_bytes()))
    actual=profile(state)
    assert actual==expected
    assert actual['horseRecent5']['20200']['n']==5
    assert actual['horse']['20200']['n']==7


def test_overlapping_days_rejected_before_counts_change():
    state=append(blank(),rows('2026-09-20',[1,2,3]));before=json.dumps(state,sort_keys=True)
    with pytest.raises(ValueError,match='overlap'):
        append(state,rows('2026-09-20',[1,2,3]))
    assert json.dumps(state,sort_keys=True)==before
