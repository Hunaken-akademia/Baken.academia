import numpy as np
import pandas as pd
import unittest

from baken_academia.schema import validate_input
from baken_academia.train import normalize_per_race, split_by_date


def _frame(days: int = 40) -> pd.DataFrame:
    rows = []
    for day in range(days):
        race_date = pd.Timestamp("2025-01-01") + pd.Timedelta(days=day)
        for horse in range(1, 5):
            rows.append(
                {
                    "race_id": f"r{day}",
                    "race_date": race_date,
                    "horse_id": f"h{day}-{horse}",
                    "finish_position": horse,
                    "racecourse": "東京",
                    "surface": "芝",
                    "distance_m": 1600,
                    "horse_number": horse,
                    "gate": horse,
                    "age": 4,
                    "sex": "牡",
                    "weight_carried": 57.0,
                }
            )
    return pd.DataFrame(rows)


class PipelineTest(unittest.TestCase):
    def test_time_split_has_no_date_overlap(self) -> None:
        frame = validate_input(_frame())
        train, validation, test = split_by_date(frame)
        groups = [set(frame.loc[mask, "race_date"]) for mask in (train, validation, test)]
        self.assertTrue(groups[0].isdisjoint(groups[1]))
        self.assertTrue(groups[0].isdisjoint(groups[2]))
        self.assertTrue(groups[1].isdisjoint(groups[2]))

    def test_probabilities_sum_to_one_per_race(self) -> None:
        race_ids = pd.Series(["a", "a", "b", "b", "b"])
        result = normalize_per_race(np.array([0.2, 0.3, 0.1, 0.2, 0.7]), race_ids)
        sums = pd.DataFrame({"race": race_ids, "p": result}).groupby("race")["p"].sum()
        self.assertTrue(np.allclose(sums.to_numpy(), 1.0))

    def test_rejects_duplicate_runner(self) -> None:
        frame = _frame()
        duplicated = pd.concat([frame, frame.iloc[[0]]], ignore_index=True)
        with self.assertRaisesRegex(ValueError, "重複"):
            validate_input(duplicated)


if __name__ == "__main__":
    unittest.main()
