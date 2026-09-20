import tempfile
import unittest
from pathlib import Path

import pandas as pd

from baken_academia.ranking_quality import _prepare, _rank_rows, _race_metrics, evaluate


class RankingQualityTest(unittest.TestCase):
    def setUp(self) -> None:
        prediction_rows = []
        race_rows = []
        fixtures = {
            "r1": {
                "probabilities": [0.50, 0.30, 0.15, 0.05],
                "finishes": [1, 3, 2, 4],
                "popularities": [2, 1, 3, 4],
            },
            "r2": {
                "probabilities": [0.45, 0.35, 0.15, 0.05],
                "finishes": [4, 1, 2, 3],
                "popularities": [1, 2, 4, 3],
            },
        }
        for race_id, values in fixtures.items():
            for index in range(4):
                horse_id = f"{race_id}-h{index + 1}"
                prediction_rows.append(
                    {
                        "race_id": race_id,
                        "race_date": "2026-01-01",
                        "horse_id": horse_id,
                        "win_probability": values["probabilities"][index],
                    }
                )
                race_rows.append(
                    {
                        "race_id": race_id,
                        "horse_id": horse_id,
                        "horse_number": index + 1,
                        "finish_position": values["finishes"][index],
                        "popularity": values["popularities"][index],
                    }
                )
        self.predictions = pd.DataFrame(prediction_rows)
        self.races = pd.DataFrame(race_rows)

    def test_rein_rank_rates_are_calculated_per_position(self) -> None:
        frame = _prepare(self.predictions, self.races)
        rows = _rank_rows(frame, "rein_rank")
        self.assertEqual([row["runners"] for row in rows], [2, 2, 2])
        self.assertAlmostEqual(rows[0]["win_rate"], 0.5)
        self.assertAlmostEqual(rows[0]["top3_rate"], 0.5)
        self.assertAlmostEqual(rows[1]["win_rate"], 0.5)
        self.assertAlmostEqual(rows[1]["top3_rate"], 1.0)
        self.assertAlmostEqual(rows[2]["top3_rate"], 1.0)

    def test_top_three_race_coverage_is_reported(self) -> None:
        frame = _prepare(self.predictions, self.races)
        metrics = _race_metrics(frame, "rein_rank")
        self.assertEqual(metrics["races"], 2)
        self.assertAlmostEqual(metrics["top3_contains_winner_rate"], 1.0)
        self.assertAlmostEqual(metrics["top3_two_or_more_placed_rate"], 1.0)
        self.assertAlmostEqual(metrics["top3_all_placed_rate"], 0.5)
        self.assertAlmostEqual(metrics["average_actual_top3_captured"], 2.5)

    def test_evaluate_writes_rein_and_popularity_report(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            predictions = root / "predictions.parquet"
            races = root / "races.parquet"
            output = root / "report"
            self.predictions.to_parquet(predictions, index=False)
            self.races.to_parquet(races, index=False)
            report = evaluate(predictions, races, output)
            methods = report["periods"]["test_2026"]
            self.assertEqual(set(methods), {"rein", "popularity"})
            self.assertTrue((output / "report.json").exists())
            self.assertTrue((output / "rank-metrics.csv").exists())
            self.assertTrue((output / "ranked-runners.parquet").exists())


if __name__ == "__main__":
    unittest.main()
