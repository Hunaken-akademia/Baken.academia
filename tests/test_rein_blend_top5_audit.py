import sys
import unittest
from pathlib import Path
import numpy as np
import pandas as pd
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from rein_blend_top5_audit import prior_rates, prior_90, rankings, paired_ci, js_round

class AuditTests(unittest.TestCase):
    def sample(self):
        return pd.DataFrame({'horse_id':['a','b','c','d'],'jockey_id':['j']*4,
          'race_date':pd.to_datetime(['2025-01-01','2025-01-01','2025-01-02','2025-04-02']),
          'finish_numeric':[1.,2.,np.nan,3.],'won':[1.,0.,0.,0.],'placed':[1.,1.,0.,1.]})
    def test_rates_exclude_entire_current_day(self):
        r=prior_rates(self.sample(),['jockey_id'],'jockey')
        np.testing.assert_array_equal(r.jockey_starts,[0,0,2,2])
        self.assertAlmostEqual(r.jockey_avg_finish[2],1.5)
    def test_90day_counts_dnf_and_excludes_today(self):
        r=prior_90(self.sample(),'jockey_id')
        self.assertAlmostEqual(r.jockey_id_recent90_win[2],2.5/22)
        self.assertAlmostEqual(r.jockey_id_recent90_win[3],1.5/21)
    def test_market_only_is_popularity(self):
        pop=np.array([3,1,2]);p=np.array([[.8,.1,.2],[.1,.2,.6],[.1,.7,.2]])
        for kind in ['overall','overall_raw','first','second','third']:
            np.testing.assert_array_equal(rankings(pop,p,np.array([1,2,3]),100,kind,np.arange(3)),[1,2,0])
    def test_rein_only_roles_are_separate(self):
        p=np.array([[.8,.1,.2],[.1,.2,.6],[.1,.7,.2]])
        for kind,top in [('first',0),('second',2),('third',1)]:
            self.assertEqual(rankings(np.array([1,2,3]),p,np.array([1,2,3]),0,kind,np.arange(3))[0],top)
    def test_js_round_half_up(self):
        np.testing.assert_array_equal(js_round(np.array([.5,1.5,2.49])),[1,2,2])
    def test_ties_keep_current_overall_order(self):
        p=np.ones((3,3))
        np.testing.assert_array_equal(rankings(np.arange(1,4),p,np.arange(1,4),0,'second',np.array([2,0,1])),[1,2,0])
    def test_identical_paired_interval(self):
        a=np.array([True,False,True]);r=paired_ci(a,a,np.array(['a','a','b']))
        self.assertEqual(r['95pct_day_cluster_interval_pp'],[0,0])
        self.assertEqual(r['gained_races'],0)
    def test_rank_within_race_probability_normalization(self):
        p=np.array([[.2,.1,.4],[.1,.3,.2],[.1,.1,.1]])
        q=p*np.array([2,4,9]);pop=np.array([1,3,2]);nums=np.arange(3)
        np.testing.assert_array_equal(rankings(pop,p,nums,35,'overall_raw'),rankings(pop,q,nums,35,'overall_raw'))

if __name__=='__main__': unittest.main()
