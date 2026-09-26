import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from rein_core import market_inputs_valid
from rein_augmented_runtime import ReinRuntime


class MarketInputTests(unittest.TestCase):
    def test_requires_popularity_and_odds_for_every_runner(self):
        valid = [{"popularity": 1, "win_odds": 2.4}, {"popularity": 2, "win_odds": 5.0}]
        self.assertTrue(market_inputs_valid(valid))
        for broken in (
            [{"popularity": 1, "win_odds": 2.4}, {"popularity": 0, "win_odds": 5.0}],
            [{"popularity": 1, "win_odds": 2.4}, {"popularity": 2, "win_odds": None}],
            [{"popularity": 1, "win_odds": 0.5}, {"popularity": 2, "win_odds": 5.0}],
            [{"popularity": None, "win_odds": None}, {"popularity": None, "win_odds": None}],
        ):
            self.assertFalse(market_inputs_valid(broken))

    def test_missing_market_skips_only_market_difference(self):
        calls = []

        class Stub(ReinRuntime):
            def __init__(self):
                self.market_models = {"first": {}}

        def base_score(self, race, runners):
            calls.append("base")
            return {"version": "t", "feature_count": 1, "runners": [{"horse_number": 1}]}

        original = ReinRuntime.__mro__[1].score
        ReinRuntime.__mro__[1].score = base_score
        try:
            result = Stub().score({}, [{"horse_number": 1, "popularity": None, "win_odds": None}])
        finally:
            ReinRuntime.__mro__[1].score = original
        self.assertEqual(calls, ["base"])
        self.assertFalse(result["market_difference_ready"])
        self.assertNotIn("market_first_probability", result["runners"][0])


if __name__ == "__main__":
    unittest.main()
