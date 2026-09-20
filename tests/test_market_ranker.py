import unittest

import numpy as np
import pandas as pd

from baken_academia.market_ranker import _probabilities, relevance_labels


class MarketRankerTest(unittest.TestCase):
    def test_relevance_labels_preserve_finish_order(self) -> None:
        result = relevance_labels(pd.Series([1, 2, 3, 4, 10, np.nan]))
        self.assertEqual(result.tolist(), [3, 2, 1, 0, 0, 0])

    def test_probabilities_normalize_inside_each_race(self) -> None:
        race_ids = pd.Series(["a", "a", "a", "b", "b"])
        scores = np.array([3.0, 2.0, 1.0, 0.5, -0.5])
        result = _probabilities(scores, race_ids)
        sums = pd.DataFrame({"race_id": race_ids, "p": result}).groupby("race_id")["p"].sum()
        self.assertTrue(np.allclose(sums.to_numpy(), 1.0))
        self.assertGreater(result[0], result[1])
        self.assertGreater(result[1], result[2])


if __name__ == "__main__":
    unittest.main()
