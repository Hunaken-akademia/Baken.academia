import unittest

import pandas as pd

from baken_academia.trifecta_hit_rate import _metrics, _outcomes


class TrifectaHitRateTest(unittest.TestCase):
    def test_exact_order_hit(self) -> None:
        races = pd.DataFrame({
            "race_id": ["r1", "r1", "r1"],
            "finish_position": [1, 2, 3],
            "horse_number": [7, 3, 11],
        })
        tickets = pd.DataFrame({
            "race_id": ["r1", "r1"], "first": [7, 3], "second": [3, 7],
            "third": [11, 11],
        })
        result = _metrics(tickets, _outcomes(races))
        self.assertEqual(result["hits"], 1)
        self.assertEqual(result["race_hit_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
