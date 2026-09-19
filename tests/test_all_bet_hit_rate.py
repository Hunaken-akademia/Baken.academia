import unittest

import pandas as pd

from baken_academia.all_bet_hit_rate import BET_CAPS, _outcomes, generate_all_bet_tickets


class AllBetHitRateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runners = pd.DataFrame({
            "race_id": ["r1"] * 10,
            "race_date": ["2026-01-01"] * 10,
            "horse_number": list(range(1, 11)),
            "gate": [1, 1, 2, 3, 4, 5, 6, 7, 8, 8],
            "win_probability": [0.22, 0.17, 0.14, 0.11, 0.09, 0.08, 0.07, 0.05, 0.04, 0.03],
        })

    def test_generates_every_bet_type_with_no_category_overlap(self) -> None:
        tickets = generate_all_bet_tickets(self.runners)
        self.assertEqual(set(tickets["bet_type"]), set(BET_CAPS))
        for bet_type, group in tickets.groupby("bet_type"):
            self.assertEqual(len(group), len(group.drop_duplicates("selection")))
            counts = group.groupby("ticket_type").size().to_dict()
            caps = BET_CAPS[bet_type]
            self.assertLessEqual(counts.get("main", 0), caps.main)
            self.assertLessEqual(counts.get("counter", 0), caps.counter)
            self.assertLessEqual(counts.get("longshot", 0), caps.longshot)
            self.assertLessEqual(max(counts.values()), 30)

    def test_builds_correct_winning_selections(self) -> None:
        races = self.runners[["race_id", "horse_number", "gate"]].copy()
        races["finish_position"] = list(range(1, 11))
        outcomes = _outcomes(races)
        def selections(bet_type):
            return set(outcomes.loc[outcomes["bet_type"] == bet_type, "selection"])
        self.assertEqual(selections("win"), {(1,)})
        self.assertEqual(selections("place"), {(1,), (2,), (3,)})
        self.assertEqual(selections("bracket_quinella"), {(1, 1)})
        self.assertEqual(selections("quinella"), {(1, 2)})
        self.assertEqual(selections("wide"), {(1, 2), (1, 3), (2, 3)})
        self.assertEqual(selections("exacta"), {(1, 2)})
        self.assertEqual(selections("trio"), {(1, 2, 3)})
        self.assertEqual(selections("trifecta"), {(1, 2, 3)})


if __name__ == "__main__":
    unittest.main()
