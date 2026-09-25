import sys,unittest
from pathlib import Path
import numpy as np
import pandas as pd
sys.path.insert(0,str(Path(__file__).resolve().parents[0]))
from rein_market_edge_research import new_features,partition_features,probabilities,cluster_ci
class EdgeTests(unittest.TestCase):
 def sample(self):
  rows=[]
  for h in range(6):
   for day in range(3):
    rows.append(dict(horse_id=str(h),race_date=pd.Timestamp('2024-01-01')+pd.Timedelta(days=day),race_id=str(day),horse_number=h+1,popularity=h+1,finish_numeric=(h+day)%6+1,horse_weight=480.,weight_carried=56.,speed_relative=.1*h,racecourse='東京',surface='芝',distance_bucket=8,wet_key=False,jockey_id='j',trainer_id='t',gate=h+1))
  x=pd.DataFrame(rows)
  f=pd.DataFrame(dict(field_size=[6.]*len(x),horse_weight_change=[0.]*len(x),horse_weight=[480.]*len(x),weight_carried=[56.]*len(x),horse_starts=[1.]*len(x),prior_early_pct=[.3]*len(x),recent3_speed_relative=[.2]*len(x),recent3_closing3f_z=[.1]*len(x),horse_top3_rate=[.25]*len(x)))
  return x,f
 def test_current_and_future_outcomes_cannot_change_features(self):
  x,f=self.sample();a,_=new_features(x,f,2)
  cut=pd.Timestamp('2024-01-02');x.loc[x.race_date>=cut,'finish_numeric']=6
  b,_=new_features(x,f,2)
  pd.testing.assert_frame_equal(a.loc[x.race_date<=cut],b.loc[x.race_date<=cut])
 def test_same_day_other_horse_outcome_is_excluded(self):
  x,f=self.sample();a,_=new_features(x,f,1)
  self.assertTrue((a.loc[x.race_date.eq(x.race_date.min()),'people_jockey_course_starts']==0).all())
  self.assertTrue((a.loc[x.race_date.eq(pd.Timestamp('2024-01-02')),'people_jockey_course_starts']==6).all())
 def test_partition_complete(self):
  x,f=self.sample();a,_=new_features(x,f,3);m,g=partition_features(a.columns)
  self.assertEqual(sorted(m+sum(g.values(),[])),sorted(a.columns))
 def test_probabilities_sum_per_race(self):
  v=probabilities(np.array([.1,.4,.1,.1]),np.array([0,0,1,1]))
  np.testing.assert_allclose(v,[.2,.8,.5,.5])
 def test_identical_bootstrap(self):
  a=np.array([True,False,True]);b=cluster_ci(a,a,['a','a','b'],boot=50)
  self.assertEqual(b['ci95_pp'],[0.,0.])
if __name__=='__main__':unittest.main()
