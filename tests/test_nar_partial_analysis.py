import unittest

import pandas as pd

from scripts.nar_partial_analysis import _race_level_market, _validate_market_columns


class NarPartialAnalysisTest(unittest.TestCase):
    def test_market_metrics_use_all_eligible_races(self):
        frame = pd.DataFrame([
            {"race_id": "R1", "finish_position": 1, "popularity": 1},
            {"race_id": "R1", "finish_position": 2, "popularity": 2},
            {"race_id": "R1", "finish_position": 3, "popularity": 3},
            {"race_id": "R2", "finish_position": 2, "popularity": 1},
            {"race_id": "R2", "finish_position": 1, "popularity": 4},
            {"race_id": "R2", "finish_position": 3, "popularity": 5},
        ])
        metrics = _race_level_market(frame)
        self.assertEqual(metrics["races"], 2)
        self.assertEqual(metrics["pop1_win_rate"], 0.5)
        self.assertEqual(metrics["pop1_top3_rate"], 1.0)
        self.assertEqual(metrics["top3_contains_winner_rate"], 0.5)

    def test_rejects_gate_misparsed_as_popularity(self):
        frame = pd.DataFrame([
            {
                "race_id": f"R{index // 10}",
                "popularity": index % 8 + 1,
                "gate": index % 8 + 1,
                "win_odds": index % 10 + 1,
                "horse_number": index % 10 + 1,
            }
            for index in range(120)
        ])
        with self.assertRaisesRegex(ValueError, "popularity is almost identical to gate"):
            _validate_market_columns(frame)


if __name__ == "__main__":
    unittest.main()
