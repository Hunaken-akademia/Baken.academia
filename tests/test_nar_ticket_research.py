import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from scripts.nar_ticket_research import METHODS, compare_results, generate_candidates, pick_tickets, settle
from scripts.nar_ticket_research import build_report


class NarTicketResearchTest(unittest.TestCase):
    def setUp(self):
        self.horses = [(1, 1), (2, 1), (3, 2), (4, 3)]
        self.roles = [[.8, .05, .05], [.1, .8, .05], [.05, .1, .8], [.05, .05, .1]]

    def test_distinct_roles_ordered_bets_and_brackets(self):
        candidates = generate_candidates(self.horses, self.roles, [1, 2, 3, 4], 'role_100')
        self.assertNotIn('trifecta', candidates)
        self.assertEqual(candidates['exacta'][0][0], (1, 2))
        self.assertIn((1, 1), dict(candidates['bracket_quinella']))
        for bet, rows in candidates.items():
            self.assertEqual(len(rows), len(dict(rows)))
            if not bet.startswith('bracket_'):
                self.assertTrue(all(len(ticket) == len(set(ticket)) for ticket, _ in rows))

    def test_budget_settlement_and_no_unknown_odds_filter(self):
        candidates = generate_candidates(self.horses, self.roles, [1, 2, 3, 4], 'role_formation')
        tickets = pick_tickets(candidates, 'exacta', 350)
        self.assertEqual(len(tickets), 3)
        total = settle(tickets + tickets, {(1, 2): 1000})
        self.assertEqual(total['spend_yen'], 300)
        self.assertEqual(total['return_yen'], 1000)
        self.assertEqual(total['hits'], 1)
        with self.assertRaises(ValueError):
            pick_tickets(candidates, 'exacta', 1000, min_odds=10)
        self.assertEqual(pick_tickets(candidates, 'win', 100, odds={(1,): 2, (2,): 20}, min_odds=10), [(2,)])

    def test_same_2025_choice_even_when_2026_ranking_reverses(self):
        rows = []
        for period in ('2025_selection', '2026_check'):
            for method in METHODS:
                roi = 1.2 if method == 'role_50' and period == '2025_selection' else .8
                if method == 'role_100' and period == '2026_check':
                    roi = 2
                rows.append(dict(period=period, method=method, bet='exacta', label='馬単',
                                 points=5, races=1000, roi=roi, race_hit_rate=.5))
        result = compare_results(rows)
        self.assertEqual(result[0]['method_selected_in_2025'], 'role_50')

    def test_report_excludes_incomplete_starting_field(self):
        rows = []
        for race, date in [('train', '2024-01-01'), ('validation', '2025-01-01'), ('audit', '2026-01-01'), ('unfinished', '2026-02-01')]:
            for horse in range(1, 5):
                unfinished = race == 'unfinished' and horse == 4
                rows.append(dict(race_id=race, race_date=date, horse_id=str(horse), horse_number=horse,
                                 gate=horse, popularity=horse, win_odds=2, distance_m=1200,
                                 racecourse='船橋', baba_code=19, surface='ダート',
                                 finish_position=None if unfinished else horse,
                                 finish_status='中止' if unfinished else str(horse),
                                 payouts=json.dumps([dict(bet_type='単勝', combination='1', payout_yen=300)])))
        model = {'status': 'provisional', 'roles': {str(t): dict(mode='absolute', intercept=0, coef=[0]) for t in (1, 2, 3)}}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pd.DataFrame(rows).to_parquet(root / 'nar-fixture.parquet')
            with patch('scripts.nar_ticket_research.fit_live_model', return_value=model), patch('scripts.nar_ticket_research.prior_features', side_effect=lambda d: np.ones((len(d), 1))), patch('scripts.nar_ticket_research.inputs_by_mode', side_effect=lambda x, r: {'absolute': x}):
                report = build_report(root, root / 'out', odds_filters=True)
            self.assertEqual(report['coverage']['evaluated_races'], 2)
            self.assertEqual(report['coverage']['skipped']['invalid_or_refund_field'], 1)
            self.assertEqual({r['period'] for r in report['results']}, {'2025_selection', '2026_check'})
            self.assertTrue((root / 'out' / 'report.json').exists())
            self.assertTrue(any(r['filter'] == 'favorite_2_3' for r in report['results']))
            self.assertTrue(all(r['bet'] != 'trifecta' for r in report['results']))


if __name__ == '__main__':
    unittest.main()
