"""The single-pass market frame builder must reproduce _market_feature_frame exactly."""
import json
import sys
import unittest
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from rein_core import ReinRuntime, prepare_inference_history


def synthetic_history(n_races=500, seed=11):
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2024-01-06", "2026-09-20", periods=n_races).normalize()
    rows = []
    for r in range(n_races):
        field = int(rng.integers(6, 16))
        horses = rng.choice(300, field, replace=False)
        finish = rng.permutation(field) + 1
        distance = int(rng.choice([1200, 1600, 2000]))
        for i in range(field):
            seconds = distance / 16.5 + rng.normal(0, 2)
            rows.append({
                "race_id": f"R{r:05d}", "race_date": dates[r], "horse_number": i + 1, "gate": i // 2 + 1,
                "finish_status": "取消" if rng.random() < .01 else "", "horse_id": f"{horses[i]:010d}",
                "jockey_id": f"{rng.integers(0, 40):05d}", "trainer_id": f"{rng.integers(0, 60):05d}",
                "finish_time": f"{int(seconds // 60)}:{seconds % 60:04.1f}", "distance_m": distance,
                "corner_positions": json.dumps([int(rng.integers(1, field + 1)), int(rng.integers(1, field + 1))]),
                "finish_position": int(finish[i]), "lap_times": json.dumps([12.1, 11.0, 11.5, 12.0]),
                "popularity": int(rng.integers(1, field + 1)), "avg_1f": float(rng.normal(12, .4)),
                "surface": str(rng.choice(["芝", "ダート"])), "race_class": str(rng.choice(["未勝利", "1勝クラス", "オープン"])),
                "racecourse": str(rng.choice(["中山", "阪神", "東京"])), "going": str(rng.choice(["良", "稍重", "重", "不良"])),
                "horse_weight": float(rng.normal(480, 20)) if rng.random() > .05 else np.nan,
                "weight_carried": float(rng.choice([54, 55, 56, 57])),
            })
    return pd.DataFrame(rows)


class MarketFrameParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = ReinRuntime.__new__(ReinRuntime)
        cls.runtime.history = prepare_inference_history(synthetic_history())
        market_root = ROOT / "api" / "models" / "market_difference"
        cls.columns = {
            (role, kind): lgb.Booster(model_file=str(market_root / f"{role}_{kind}.txt")).feature_name()
            for role in ("first", "second", "third") for kind in ("market", "rein")
        }

    def runners(self, seed, size, unknown_horse):
        rng = np.random.default_rng(seed)
        ids = list(rng.choice(self.runtime.history["horse_id"].unique(), size, replace=False))
        if unknown_horse:
            ids[0] = "999999"
        pops = rng.permutation(size) + 1
        return [{
            "horse_number": i + 1, "gate": i // 2 + 1, "horse_id": ids[i],
            "jockey_id": str(rng.integers(0, 40)), "trainer_id": str(rng.integers(0, 60)),
            "age": 4, "sex": "せん" if i == 1 else "牡", "weight_carried": 56,
            "horse_weight": 470 + i if i != 3 else None, "horse_weight_change": 0 if i == 2 else 4,
            "popularity": int(pops[i]), "win_odds": float(1.4 + pops[i] * 1.9),
        } for i in range(size)]

    def test_frames_equal_the_per_target_builder(self):
        cases = [
            ({"race_date": "2026-09-26", "racecourse": "中山", "surface": "ダート", "distance_m": 1200,
              "going": "重", "race_class": "1勝クラス"}, 1, 12, False),
            ({"race_date": "2025-06-01", "racecourse": "阪神", "surface": "芝", "distance_m": 2000,
              "going": "良", "race_class": "オープン"}, 2, 9, True),
            ({"race_date": "2026-01-10", "racecourse": "東京", "surface": "芝", "distance_m": 1600,
              "going": None, "race_class": None}, 3, 16, True),
        ]
        runtime = self.runtime
        for race, seed, size, unknown in cases:
            runners = self.runners(seed, size, unknown)
            full = runtime._feature_frame_full(race, runners)
            frames = runtime._market_feature_frames(full, race, runners)
            for (role, kind), columns in self.columns.items():
                target = {"first": 1, "second": 2, "third": 3}[role]
                expected = runtime._market_feature_frame(full, race, runners, target, columns)
                actual = runtime._market_frame_columns(frames, target, columns)
                pd.testing.assert_frame_equal(actual, expected, check_exact=True)


if __name__ == "__main__":
    unittest.main()
