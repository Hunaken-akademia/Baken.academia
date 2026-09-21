import unittest

from baken_academia.jra_all_payouts import parse_all_payouts


class JraAllPayoutsTest(unittest.TestCase):
    def test_parses_all_standard_bet_types(self) -> None:
        rows = "".join([
            "<tr><th>単勝</th><td>7</td><td>430円</td></tr>",
            "<tr><th>複勝</th><td>7</td><td>180円</td></tr>",
            "<tr><th>枠連</th><td>3-4</td><td>920円</td></tr>",
            "<tr><th>馬連</th><td>3-7</td><td>1,820円</td></tr>",
            "<tr><th>ワイド</th><td>3-7</td><td>610円</td></tr>",
            "<tr><th>馬単</th><td>7→3</td><td>3,400円</td></tr>",
            "<tr><th>3連複</th><td>3-7-11</td><td>8,200円</td></tr>",
            "<tr><th>3連単</th><td>7→3→11</td><td>125,430円</td></tr>",
        ])
        page = f'''<div id="race_result_1R"><div class="date_line"><div class="date">
        2026年1月5日 1回中山1日</div></div><table>{rows}</table></div>'''.encode("cp932")
        payouts = parse_all_payouts(page, "sample")
        self.assertEqual({row["bet_type"] for row in payouts}, {
            "win", "place", "bracket_quinella", "quinella", "wide", "exacta", "trio", "trifecta"
        })
        trifecta = next(row for row in payouts if row["bet_type"] == "trifecta")
        self.assertEqual((trifecta["selection_1"], trifecta["selection_2"], trifecta["selection_3"]),
                         (7, 3, 11))
        self.assertEqual(trifecta["payout_yen_per_100"], 125430)

    def test_parses_current_jra_refund_cards(self) -> None:
        refunds = """<div class="refund_area"><div class="refund_unit"><ul>
        <li class="win"><dl><dt>単勝</dt><dd><div class="line">
          <div class="num">4</div><div class="yen">280<span>円</span></div>
        </div></dd></dl></li>
        <li class="place"><dl><dt>複勝</dt><dd>
          <div class="line"><div class="num">4</div><div class="yen">110<span>円</span></div></div>
          <div class="line"><div class="num">11</div><div class="yen">150<span>円</span></div></div>
          <div class="line"><div class="num">1</div><div class="yen">280<span>円</span></div></div>
        </dd></dl></li>
        <li class="umatan"><dl><dt>馬単</dt><dd><div class="line">
          <div class="num">4-11</div><div class="yen">1,200<span>円</span></div>
        </div></dd></dl></li>
        <li class="tierce"><dl><dt>3連単</dt><dd><div class="line">
          <div class="num">4-11-1</div><div class="yen">6,880<span>円</span></div>
        </div></dd></dl></li>
        </ul></div></div>"""
        page = f'''<div id="race_result_1R"><div class="date_line"><div class="date">
        2026年9月13日 4回阪神4日</div></div>{refunds}</div>'''.encode("cp932")
        payouts = parse_all_payouts(page, "sample")
        self.assertEqual(len(payouts), 6)
        self.assertEqual([row["payout_yen_per_100"] for row in payouts if row["bet_type"] == "place"],
                         [110, 150, 280])
        trifecta = next(row for row in payouts if row["bet_type"] == "trifecta")
        self.assertEqual((trifecta["selection_1"], trifecta["selection_2"], trifecta["selection_3"]),
                         (4, 11, 1))
        self.assertEqual(trifecta["payout_yen_per_100"], 6880)


if __name__ == "__main__":
    unittest.main()
