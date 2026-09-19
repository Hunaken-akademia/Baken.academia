import unittest

from baken_academia.jra_trifecta_backfill import parse_trifecta_payouts


class JraTrifectaBackfillTest(unittest.TestCase):
    def test_parses_trifecta_order_and_payout(self) -> None:
        page = '''<html><body><div id="race_result_1R">
        <div class="date_line"><div class="date">2026年1月5日 1回中山1日</div></div>
        <div class="race_title"><div class="category">3歳</div><div class="class">未勝利</div>
        <span class="race_name">sample</span><div class="course">コース：1,200メートル（ダート・右）</div></div>
        <table class="striped"><tbody>
        <tr><td class="place">1</td><td class="num">7</td><td class="horse"><a href="/JRADB/accessU.html?CNAME=pw01dud101/AA">A</a></td><td class="age">牡3</td></tr>
        </tbody></table>
        <table class="payout"><tr><th>3連単</th><td>7→3→11</td><td>125,430円</td></tr></table>
        </div></body></html>'''.encode("cp932")
        rows = parse_trifecta_payouts(page, "sample")
        self.assertEqual(rows[0]["race_id"], "20260105-中山-01")
        self.assertEqual((rows[0]["first"], rows[0]["second"], rows[0]["third"]), (7, 3, 11))
        self.assertEqual(rows[0]["payout_yen_per_100"], 125430)


if __name__ == "__main__":
    unittest.main()
