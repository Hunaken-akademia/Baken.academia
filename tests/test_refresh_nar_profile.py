import gzip,json,sys
from pathlib import Path
import pandas as pd
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from refresh_nar_profile import GROUPS,append,collect_pedigrees,parse_pedigree,profile
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
    state['pedigree']={'20200':['エイシンヒカリ','アグネスデジタル'],'20201':['エイシン ヒカリ','']}
    with_sires=profile(state)
    assert {k:v for k,v in with_sires.items() if k!='meta' and not k.startswith('sire')}=={k:v for k,v in expected.items() if k!='meta'}
    # Progeny counts are exact sums of each offspring's counts (spacing in names ignored):
    # finishes 1,4,1,4,1,4,1 plus seven 2nds = 14 starts, 4 wins, 11 top three, finish sum 30.
    assert with_sires['sire']['エイシンヒカリ']==dict(n=14,w=round(5.5/34,5),t=round(15.5/34,5),f=round(30/14,3))
    assert with_sires['sireDistance']['エイシンヒカリ|7']['n']==14 and with_sires['sireCourse']['エイシンヒカリ|金沢']['n']==14
    assert with_sires['meta']['pedigreeCoverage']==round(14/21,4)
    assert actual['horseRecent5']['20200']['n']==5
    assert actual['horse']['20200']['n']==7


def test_overlapping_days_rejected_before_counts_change():
    state=append(blank(),rows('2026-09-20',[1,2,3]));before=json.dumps(state,sort_keys=True)
    with pytest.raises(ValueError,match='overlap'):
        append(state,rows('2026-09-20',[1,2,3]))
    assert json.dumps(state,sort_keys=True)==before


PAGE='''<div class="pedigree"><table><tbody><tr><td class="blue" rowspan="2">父</td><td class="fathername" rowspan="2">
          St Mark&#039;s Basilica</td><td class="blue">父父</td><td class="Paternalfathername"> Siyouni</td></tr>
<tr><td class="pink">父母</td><td> Cabaret</td></tr><tr><td class="pink" rowspan="2">母</td><td rowspan="2"> 母馬</td>
<td class="blue">母父</td><td> アグネスデジタル</td></tr></tbody></table></div>'''


def test_pedigree_page_parses_sire_and_dam_sire():
    assert parse_pedigree(PAGE)==["St Mark's Basilica",'アグネスデジタル']
    assert parse_pedigree('<html>no table</html>') is None


def test_pedigree_collection_is_budgeted_prioritized_and_resumable():
    state=append(blank(),rows('2026-09-20',[1,2,3]));state['knownHorses']=['20200','20201','20202']
    state['counts']['horse']['20202']=[50,0,0,0]
    calls=[];now=[0.0]
    def fetch(horse):
        calls.append(horse)
        if horse=='20201':raise RuntimeError('timeout')
        return PAGE if horse!='20202' else '<html></html>'
    def sleep(seconds):now[0]+=seconds
    first=collect_pedigrees(state,['20200'],8,fetch=fetch,delay=(4,4),clock=lambda:now[0],sleep=sleep)
    # Today's runner first, then the horse with the most starts; the budget stops the third request.
    assert calls==['20200','20202'] and first=={'added':1,'failures':0,'remaining':1}
    assert state['pedigree']=={'20200':["St Mark's Basilica",'アグネスデジタル'],'20202':['','']}
    second=collect_pedigrees(state,[],100,fetch=fetch,delay=(4,4),clock=lambda:now[0],sleep=sleep)
    assert calls[2:]==['20201'] and second=={'added':0,'failures':1,'remaining':1}
