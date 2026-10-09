import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from scripts.nar_all_bet_analysis import LABELS, PAGE, build_report, payout_map, selections


class AllBetAnalysisTest(unittest.TestCase):
    def test_order_and_bracket_deduplication(self):
        runners = [(1, 1), (2, 1), (3, 2)]
        self.assertEqual(len(selections(runners, 'trifecta', 3)), 6)
        self.assertEqual(selections(runners, 'trio', 3), {(1, 2, 3)})
        self.assertEqual(selections(runners, 'bracket_quinella', 3), {(1, 1), (1, 2)})
        self.assertEqual(selections(runners, 'bracket_exacta', 3), {(1, 1), (1, 2), (2, 1)})
        self.assertFalse(selections(runners, 'exacta', 1))

    def test_official_dead_heat_and_order(self):
        rows = [{'bet_type': '馬連複', 'combination': '２－１', 'payout_yen': 400},
                {'bet_type': '馬連複', 'combination': '1-3', 'payout_yen': 500},
                {'bet_type': '馬単', 'combination': '2-1', 'payout_yen': 700},
                {'bet_type': '単勝', 'combination': '返還', 'payout_yen': 100}]
        payouts = payout_map(json.dumps(rows))
        self.assertEqual(payouts['quinella'], {(1, 2): 400, (1, 3): 500})
        self.assertEqual(payouts['exacta'], {(2, 1): 700})
        self.assertNotIn('win', payouts)

    def test_all_nine_bets_and_stakes_end_to_end(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            winners = {'win': '1', 'place': '1', 'bracket_quinella': '1-2',
                       'bracket_exacta': '1-2', 'quinella': '1-2', 'exacta': '1-2',
                       'wide': '1-2', 'trio': '1-2-3', 'trifecta': '1-2-3'}
            payouts = json.dumps([{'bet_type': LABELS[bet], 'combination': combo,
                                  'payout_yen': 600} for bet, combo in winners.items()])
            frame = pd.DataFrame([dict(race_id='R1', horse_id=str(h), race_date='2021-01-01',
                racecourse='船橋', baba_code=19, surface='ダート', horse_number=h, gate=h,
                popularity=h, win_odds=2.0*h, distance_m=1200, finish_position=h,
                finish_status=str(h), payouts=payouts) for h in (1, 2, 3)])
            source = root / 'result.parquet'
            frame.to_parquet(source)
            pd.DataFrame([dict(race_id='R1', bet_type=page, cells=10)
                          for page in set(PAGE.values())]).to_parquet(root / 'test-odds-manifest.parquet')
            report = build_report(source, root, root / 'out')
            rows = {r['bet']: r for r in report['results'] if r['top_k'] == 3}
            self.assertEqual(set(rows), set(LABELS))
            self.assertEqual(rows['trifecta']['spend_yen'], 600)
            self.assertEqual(rows['trifecta']['roi'], 1)
            self.assertEqual(rows['trio']['roi'], 6)
            self.assertTrue(all(r['race_hit_rate'] == 1 for r in rows.values()))
            self.assertEqual({r['method'] for r in report['results']}, {'final_market_reference'})
            self.assertFalse(report['production_changed'])


if __name__ == '__main__':
    unittest.main()
