import unittest

import pandas as pd

from baken_academia.bet_strategy_comparison import (
    build_outcomes,
    generate_popularity_tickets,
    generate_wake_tickets,
    wake_position_probabilities,
)


class BetStrategyComparisonTest(unittest.TestCase):
    def setUp(self) -> None:
        n = 10
        self.runners = pd.DataFrame({
            "race_id": ["r1"] * n,
            "race_date": ["2026-01-01"] * n,
            "horse_number": list(range(1, n + 1)),
            "gate": [1, 1, 2, 3, 4, 5, 6, 7, 8, 8],
            "popularity": list(range(1, n + 1)),
            "win_probability": [0.22, 0.17, 0.14, 0.11, 0.09, 0.08, 0.07, 0.05, 0.04, 0.03],
            "horse_recent5_win_rate": [0.4, 0.3, 0.2, 0.1, 0.0] * 2,
            "horse_recent5_top3_rate": [0.7, 0.6, 0.5, 0.4, 0.3] * 2,
            "horse_recent5_avg_finish": [2, 3, 4, 5, 6] * 2,
            "horse_win_rate": [0.2] * n,
            "horse_top3_rate": [0.5] * n,
            "jockey_win_rate": [0.15] * n,
            "jockey_top3_rate": [0.4] * n,
            "trainer_win_rate": [0.1] * n,
            "trainer_top3_rate": [0.35] * n,
            "horse_surface_top3_rate": [0.4] * n,
            "horse_distance_top3_rate": [0.4] * n,
            "horse_course_top3_rate": [0.4] * n,
        })

    def test_position_probabilities_are_normalized(self) -> None:
        roles = wake_position_probabilities(self.runners, 0.75)
        for column in ("first_probability", "second_probability", "third_probability"):
            self.assertAlmostEqual(float(roles[column].sum()), 1.0, places=10)

    def test_all_methods_respect_caps_and_no_overlap(self) -> None:
        for tickets in (generate_wake_tickets(self.runners, 0.75),
                        generate_popularity_tickets(self.runners)):
            for _, group in tickets.groupby("bet_type"):
                self.assertEqual(len(group), len(group.drop_duplicates("selection")))
                self.assertLessEqual(group.groupby("ticket_type").size().max(), 30)

    def test_dead_heat_and_place_field_rule(self) -> None:
        races = self.runners[["race_id", "horse_number", "gate"]].copy()
        races["finish_position"] = [1, 1, 3, 4, 5, 6, 7, 8, 9, 10]
        outcomes, eligible = build_outcomes(races)
        tri = set(outcomes.loc[outcomes["bet_type"] == "trifecta", "selection"])
        self.assertEqual(tri, {(1, 2, 3), (2, 1, 3)})
        self.assertIn("r1", eligible["bracket_quinella"])
        place = set(outcomes.loc[outcomes["bet_type"] == "place", "selection"])
        self.assertEqual(place, {(1,), (2,), (3,)})


if __name__ == "__main__":
    unittest.main()
