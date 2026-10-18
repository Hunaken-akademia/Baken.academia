import unittest
from unittest.mock import patch
import numpy as np
import pandas as pd
from scripts.rein_comprehensive_validation import enrich, prior_features, by_adjust, cluster_stats
from scripts.nar_live_model import fit_live_model

class ComprehensiveResearchTest(unittest.TestCase):
 def fixture(self):
  rows=[]
  for day in ['2024-01-01','2024-02-01','2024-03-01']:
   for race in [1,2]:
    for horse in range(1,5):
     rows.append(dict(race_id=f'{day}-{race}',race_date=day,race_name='test',racecourse='佐賀',surface='ダート',going='良',distance_m=1400,horse_id=str(horse),jockey_id=str(horse),trainer_id='1',gate=horse,horse_number=horse,sex='牡',age=4,weight_carried=56,horse_weight=480,horse_weight_change=0,finish_status=str(horse),finish_position=horse))
  return enrich(pd.DataFrame(rows))
 def test_same_day_and_future_results_never_change_features(self):
  d=self.fixture();a=prior_features(d);changed=d.copy();changed.loc[changed.race_date.ge('2024-02-01'),'finish_position']=1
  b=prior_features(changed);pd.testing.assert_frame_equal(a.loc[d.race_date.le('2024-02-01')],b.loc[d.race_date.le('2024-02-01')])
  self.assertFalse(a.loc[d.race_date.eq('2024-03-01')].equals(b.loc[d.race_date.eq('2024-03-01')]))
 def test_recent_features_ignore_current_and_future_outcomes(self):
  from scripts.rein_comprehensive_recent import recent_features
  d=self.fixture();a=recent_features(d);changed=d.copy();changed.loc[changed.race_date.ge('2024-02-01'),'finish_position']=1
  b=recent_features(changed);pd.testing.assert_frame_equal(a.loc[d.race_date.le('2024-02-01')],b.loc[d.race_date.le('2024-02-01')])
 def test_unknown_identifiers_do_not_share_fake_form(self):
  d=self.fixture();d.horse_id='';f=prior_features(d)
  self.assertTrue(f.horse_n.eq(0).all());self.assertTrue(np.allclose(f.horse_r1,1.5/20))
 def test_by_adjustment_and_cluster_uncertainty(self):
  q=by_adjust([.01,.02,.9]);self.assertTrue(all(x>=y for x,y in zip(q,[.01,.02,.9])))
  z=cluster_stats(np.zeros(60),np.repeat(np.arange(30),2));self.assertEqual(z['p_one_sided'],1.)
 def test_research_coefficients_ignore_audit_outcomes(self):
  n=1200;d=pd.DataFrame({'race_id':np.repeat(np.arange(3*n//6),6),'race_date':np.repeat(['2024-01-01','2025-01-01','2026-01-01'],n),'horse_number':np.tile(np.arange(1,7),3*n//6),'finish_position':np.tile(np.arange(1,7),3*n//6),'popularity':np.tile(np.arange(1,7),3*n//6)})
  x=np.random.default_rng(42).normal(size=(len(d),3));changed=d.copy();changed.loc[changed.race_date.eq('2026-01-01'),'finish_position']=np.where(x[-n:,0]>0,1,4)
  def features(frame):return x
  with patch('scripts.nar_live_model.prior_features',side_effect=features):
   first=fit_live_model(d,refit_for_serving=False);second=fit_live_model(changed,refit_for_serving=False)
  self.assertEqual(first['roles'],second['roles']);self.assertFalse(first['refitForServing']);self.assertEqual(first['coefficientTrainingPeriod'],'2019-2024 only')

if __name__=='__main__':unittest.main()
