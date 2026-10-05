import importlib.util
from pathlib import Path
import pandas as pd
spec=importlib.util.spec_from_file_location('jockey_ref',Path(__file__).resolve().parents[1]/'scripts/build_jockey_reference.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def test_exact_counts_dnf_scratches_and_course_identity():
 rows=[]
 for i,(finish,status) in enumerate([(1,'1'),(2,'2'),(3,'3'),(None,'中止'),(None,'取消')]):
  rows.append(dict(race_id=str(i),race_date='2024-01-01',horse_number=1,jockey_id='001',jockey_name='テスト 騎手',racecourse='大井',baba_code=20,surface='ダート',distance_m=1600,direction='右',gate=8,finish_position=finish,finish_status=status))
 data=pd.DataFrame(rows);p,r=m.build(pd.concat([data,data.iloc[:1]]),'nar');j=p['jockeys']['1'];assert j['groups']['all']['']==[4,1,2,3];assert j['groups']['venueDistance']['大井|ダート|1600']==[4,1,2,3];assert j['groups']['turn']['右回り']==[4,1,2,3];assert j['name']=='テスト騎手';assert r['meta']['starts']==4

def test_temporal_selection_does_not_use_future_winners():
 rows=[]
 for year,venue,wins in [(2024,'東京',30),(2024,'中山',0),(2025,'東京',10),(2025,'中山',49)]:
  for i in range(50): rows.append(dict(race_id=f'{year}-{venue}-{i}',race_date=f'{year}-01-01',horse_number=1,jockey_id='1',jockey_name='騎手',racecourse=venue,surface='芝',course_detail='左',distance_m=1600,gate=1,finish_position=1 if i<wins else 4,finish_status='確定'))
 p,r=m.build(pd.DataFrame(rows),'jra');audit=r['temporalAudit']['venueSurface']['2025'];assert audit['starts']==50;assert audit['top3']==10
