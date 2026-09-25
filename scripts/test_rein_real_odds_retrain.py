import unittest
import numpy as np
import pandas as pd
from rein_real_odds_retrain import odds_features, score_predictions, summarize

class RealOddsTests(unittest.TestCase):
    def sample(self):
        meta = pd.DataFrame({'race_id': ['a']*6+['b']*6,
            'horse_number': list(range(1,7))*2,
            'race_date': pd.to_datetime(['2025-01-01']*6+['2026-01-01']*6),
            'popularity': list(range(1,7))*2,
            'finish_numeric': [2,1,3,4,5,6,1,2,3,4,5,6]})
        odds = meta[['race_id','horse_number','race_date']].copy()
        odds['win_odds'] = [2.,4.,6.,9.,14.,20.]*2
        odds['place_odds_min'] = [1.,1.5,2.,3.,4.,6.]*2
        odds['place_odds_max'] = [1.4,2.,3.,4.,6.,9.]*2
        return meta, odds

    def test_complete_and_normalized(self):
        m,o = self.sample();f,keep,_ = odds_features(m,o)
        self.assertTrue(keep.all())
        self.assertTrue(np.isfinite(f.to_numpy()).all())
        np.testing.assert_allclose(f.odds_win_share.groupby(m.race_id).sum(), [1,1])

    def test_one_missing_horse_excludes_entire_race(self):
        m,o = self.sample();o.loc[2,'win_odds'] = np.nan
        _,keep,_ = odds_features(m,o)
        np.testing.assert_array_equal(keep, [False]*6+[True]*6)

    def test_wrong_date_excludes_entire_race(self):
        m,o = self.sample();o.loc[7,'race_date'] = pd.Timestamp('2020-01-01')
        _,keep,_ = odds_features(m,o)
        np.testing.assert_array_equal(keep, [True]*6+[False]*6)

    def test_odds_independent_of_current_results(self):
        m,o = self.sample();a,_,_ = odds_features(m,o)
        m['finish_numeric'] = 6
        b,_,_ = odds_features(m,o)
        pd.testing.assert_frame_equal(a,b)

    def test_duplicates_rejected(self):
        m,o = self.sample()
        with self.assertRaises(pd.errors.MergeError):
            odds_features(m,pd.concat([o,o.iloc[:1]],ignore_index=True))

    def test_bad_place_range_excludes_race(self):
        m,o = self.sample();o.loc[0,'place_odds_min'] = 10
        _,keep,_ = odds_features(m,o)
        self.assertFalse(keep[:6].any())

    def test_exact_finisher_metrics_and_race_probability(self):
        m,o = self.sample();r,p = score_predictions(m,1/o.win_odds.to_numpy(),1)
        np.testing.assert_allclose(pd.Series(p).groupby(m.race_id).sum(),[1,1])
        np.testing.assert_array_equal(r.top1,[False,True])
        self.assertTrue(r.top2.all())
        self.assertTrue((r.log_loss>0).all())

    def test_missing_confirmation_period_rejected(self):
        m,o = self.sample();r,_ = score_predictions(m,1/o.win_odds.to_numpy(),1)
        with self.assertRaises(ValueError): summarize(r)

if __name__ == '__main__': unittest.main()
