import importlib.util,sys
from pathlib import Path
import pandas as pd
import numpy as np
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'scripts'))
spec=importlib.util.spec_from_file_location('correction',root/'scripts/jockey_correction_experiments.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def rows():
 return pd.DataFrame([dict(race_id=f'{day}-{i}',race_date=day,horse_number=1,jockey_id='1',jockey_name='騎手',racecourse='東京' if i%2==0 else '中山',surface='芝',course_detail='左',distance_m=1600,gate=1,finish_position=1 if i%2==0 else 4,finish_status='確定') for day in ['2024-01-01','2024-01-02','2024-01-03'] for i in range(60)])
def test_same_day_results_cannot_change_any_target_signal():
 d=rows();keys,a=m.condition_signals(d,'jra');changed=d.copy();changed.loc[changed.race_date.eq('2024-01-03'),'finish_position']=3;_,b=m.condition_signals(changed,'jra');assert keys.equals(m.condition_signals(changed,'jra')[0]);
 for name in a:np.testing.assert_array_equal(a[name],b[name])
 assert np.all(a['venueSurface'][:60]==0)
def test_exact_roles_and_uniform_signal_are_distinct_and_zero_preserves_order():
 s=np.array([[.5,0,-.5],[0,.5,0]]);c=list(m.candidates({'turn':s},0));assert any(np.any(signal) for name,signal,alpha in c if '-exact-' in name);assert any(np.all(signal==np.array([0,1/6])) for name,signal,alpha in c if '-uniform-' in name)
 base=np.array([.1,.3,.2]);np.testing.assert_array_equal(np.argsort(base),np.argsort(m.correction(base,np.zeros(3),.5)))

def test_rolling_counts_exclude_today_and_expired_dates():
 d=pd.DataFrame({'id':['a']*4,'race_date':pd.to_datetime(['2024-01-01','2024-01-02','2024-04-01','2024-04-01']),'n':[1]*4,'y1':[1,0,1,1],'y2':[0]*4,'y3':[0]*4})
 actual=m.rolling_counts(d,['id'],90)
 np.testing.assert_array_equal(actual[:,0],[0,1,1,1])
 np.testing.assert_array_equal(actual[:,1],[0,1,0,0])

def test_extended_signals_are_prior_day_and_ignore_future_and_unknown_pairs():
 d=rows();d['horse_id']='h';d['trainer_id']='t';d['popularity']=4
 keys,a,_=m.extended_signals(d,'jra')
 changed=d.copy();changed.loc[changed.race_date.eq('2024-01-03'),'finish_position']=3
 _,b,_=m.extended_signals(changed,'jra')
 for name in a:np.testing.assert_array_equal(a[name],b[name])
 future=d.iloc[:60].copy();future['race_date']='2025-01-01';future['race_id']='future-'+future.index.astype(str)
 _,c,_=m.extended_signals(pd.concat([d,future],ignore_index=True),'jra')
 for name in a:np.testing.assert_array_equal(a[name],c[name][:len(d)])
 d['horse_id']='';_,z,_=m.extended_signals(d,'jra');assert np.all(z['horsePair']==0)
