import gzip
import json
import sys
import unittest
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from rein_core import ReinRuntime


class RecordingModel:
    def __init__(self, output):
        self.output = np.asarray(output, dtype=float)
        self.seen = None

    def predict(self, frame):
        self.seen = frame.copy()
        return self.output.copy()


class SecondRoleModelTests(unittest.TestCase):
    def test_packaged_model_matches_schema(self):
        model_root = ROOT / "api" / "models"
        schema = json.loads((model_root / "second_joint_v5.schema.json").read_text())
        with gzip.open(model_root / "second_joint_v5.txt.gz", "rt", encoding="utf-8") as source:
            model = lgb.Booster(model_str=source.read())

        self.assertEqual(schema["second_class_index"], 2)
        self.assertEqual(len(schema["feature_order"]), 124)
        self.assertEqual(model.num_feature(), len(schema["feature_order"]))

    def test_only_second_role_uses_new_model(self):
        first = RecordingModel([0.7, 0.3])
        third = RecordingModel([0.2, 0.8])
        joint = RecordingModel([[0.1, 0.2, 0.8, 0.3], [0.1, 0.2, 0.2, 0.3]])
        runtime = ReinRuntime(
            history=pd.DataFrame(),
            schema={
                "feature_order": ["horse_weight_change"],
                "role_feature_order": {
                    "third": ["horse_weight_change", "horse_wet_prior_top3_rate"]
                },
            },
            models={"first": first, "third": third},
            second_joint_schema={"feature_order": ["horse_weight_change"], "second_class_index": 2},
            second_joint_model=joint,
            version="test",
        )
        runtime._feature_frame_full = lambda race, runners: pd.DataFrame(
            {
                "horse_weight_change": [0.0, 2.0],
                "horse_wet_prior_top3_rate": [0.4, 0.6],
            }
        )

        result = runtime.score({}, [
            {"horse_number": 1, "horse_weight_change": 0},
            {"horse_number": 2, "horse_weight_change": 2},
        ])

        self.assertTrue(np.isnan(first.seen.iloc[0, 0]))
        self.assertEqual(list(third.seen.columns), [
            "horse_weight_change", "horse_wet_prior_top3_rate"
        ])
        self.assertTrue(np.isnan(third.seen.iloc[0, 0]))
        self.assertEqual(third.seen.iloc[0, 1], 0.4)
        self.assertEqual(joint.seen.iloc[0, 0], 0.0)
        self.assertEqual(
            [runner["first_probability"] for runner in result["runners"]],
            [0.7, 0.3],
        )
        self.assertEqual(
            [runner["second_probability"] for runner in result["runners"]],
            [0.8, 0.2],
        )
        self.assertEqual(
            [runner["third_probability"] for runner in result["runners"]],
            [0.2, 0.8],
        )


if __name__ == "__main__":
    unittest.main()
