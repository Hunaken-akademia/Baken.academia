import unittest

import pandas as pd

from baken_academia.ingest import standardize


class IngestTest(unittest.TestCase):
    def test_maps_japanese_columns_and_extracts_weight(self) -> None:
        source = pd.DataFrame(
            {
                "レースID": ["r1"],
                "開催日": ["2026-01-01"],
                "馬ID": ["h1"],
                "着順": ["1着"],
                "競馬場": ["東京"],
                "芝ダート": ["芝1600"],
                "距離": ["1600m"],
                "馬番": [1],
                "枠番": [1],
                "馬齢": ["牡4"],
                "性別": ["牡"],
                "斤量": ["57.0kg"],
                "馬体重": ["480(+2)"],
            }
        )
        result, mapping = standardize(source)
        self.assertEqual(result.loc[0, "surface"], "芝")
        self.assertEqual(result.loc[0, "horse_weight"], 480)
        self.assertEqual(result.loc[0, "horse_weight_change"], 2)
        self.assertEqual(mapping["着順"], "finish_position")


if __name__ == "__main__":
    unittest.main()
