import unittest

from baken_academia.jra_all_odds_backfill import (
    parse_all_odds_cnames,
    parse_odds_cells,
    parse_odds_cname,
    parse_win_place_odds,
)


class JraAllOddsBackfillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tail = "1009202604040120260913Z/36"

    def test_discovers_all_seven_pages_and_classifies_them(self) -> None:
        payload = " ".join(f"pw15{kind}ou{self.tail}" for kind in range(1, 8)).encode()
        cnames = parse_all_odds_cnames(payload)
        self.assertEqual(len(cnames), 7)
        self.assertEqual(parse_odds_cname(cnames[-1])["bet_type"], "trifecta")

    def test_preserves_generic_cells_and_parses_win_place_ranges(self) -> None:
        page = '''<table class="basic narrow-xy tanpuku"><tr>
        <th class="num">馬番</th><th class="odds_tan">単勝</th><th class="odds_fuku">複勝</th></tr>
        <tr><td class="num">4</td><td class="odds_tan">2.8</td>
        <td class="odds_fuku">1.1 - 1.2</td></tr></table>'''.encode("cp932")
        cname = f"pw151ou{self.tail}"
        cells = parse_odds_cells(page, cname)
        self.assertTrue(any(row["text"] == "複勝" for row in cells))
        row = parse_win_place_odds(page, cname)[0]
        self.assertEqual(row["horse_number"], 4)
        self.assertEqual((row["win_odds"], row["place_odds_min"], row["place_odds_max"]),
                         (2.8, 1.1, 1.2))


if __name__ == "__main__":
    unittest.main()
