import unittest

import pandas as pd

from baken_academia.ranking_blend import _rank, _role_rank, _scores


class RankingBlendTest(unittest.TestCase):
    def setUp(self) -> None:
        self.frame = pd.DataFrame(
            [
                {"race_id": "r1", "race_date": pd.Timestamp("2026-01-01"), "horse_id": "a",
                 "win_probability": 0.20, "popularity_sort": 1.0},
                {"race_id": "r1", "race_date": pd.Timestamp("2026-01-01"), "horse_id": "b",
                 "win_probability": 0.60, "popularity_sort": 2.0},
                {"race_id": "r1", "race_date": pd.Timestamp("2026-01-01"), "horse_id": "c",
                 "win_probability": 0.15, "popularity_sort": 3.0},
                {"race_id": "r1", "race_date": pd.Timestamp("2026-01-01"), "horse_id": "d",
                 "win_probability": 0.05, "popularity_sort": 4.0},
            ]
        )

    def test_alpha_endpoints_match_market_and_rein(self) -> None:
        market = _rank(self.frame, 0.0).sort_values("blend_rank")
        rein = _rank(self.frame, 1.0).sort_values("blend_rank")
        self.assertEqual(market.iloc[0]["horse_id"], "a")
        self.assertEqual(rein.iloc[0]["horse_id"], "b")
        self.assertAlmostEqual(_scores(self.frame, 0.0).sum(), 1.0)
        self.assertAlmostEqual(_scores(self.frame, 1.0).sum(), 1.0)

    def test_role_rank_uses_separate_first_and_top3_weights(self) -> None:
        ranked = _role_rank(self.frame, first_alpha=1.0, top3_alpha=0.0)
        ordered = ranked.sort_values("hybrid_rank")["horse_id"].tolist()
        self.assertEqual(ordered, ["b", "a", "c", "d"])
        self.assertEqual(sorted(ranked["hybrid_rank"].tolist()), [1, 2, 3, 4])


if __name__ == "__main__":
    unittest.main()
