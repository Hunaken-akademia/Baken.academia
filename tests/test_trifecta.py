import unittest

import pandas as pd

from baken_academia.trifecta import TicketPlan, generate_tickets, ordered_probability


class TrifectaTest(unittest.TestCase):
    def test_ordered_probabilities_sum_to_one(self) -> None:
        probabilities = [0.5, 0.3, 0.2]
        total = 0.0
        for first in range(3):
            for second in range(3):
                for third in range(3):
                    if len({first, second, third}) == 3:
                        total += ordered_probability(
                            probabilities[first], probabilities[second], probabilities[third]
                        )
        self.assertAlmostEqual(total, 1.0)

    def test_main_allows_multiple_heads_and_categories_do_not_overlap(self) -> None:
        runners = pd.DataFrame({
            "race_id": ["r1"] * 8,
            "race_date": ["2026-01-01"] * 8,
            "horse_number": list(range(1, 9)),
            "win_probability": [0.25, 0.20, 0.16, 0.13, 0.10, 0.07, 0.05, 0.04],
        })
        tickets = generate_tickets(runners, TicketPlan(main=30, counter=40, longshot=50))
        main = tickets.loc[tickets["ticket_type"] == "main"]
        self.assertGreater(len(set(main["first"])), 1)
        self.assertEqual(
            len(tickets), len(tickets.drop_duplicates(["first", "second", "third"]))
        )


if __name__ == "__main__":
    unittest.main()
