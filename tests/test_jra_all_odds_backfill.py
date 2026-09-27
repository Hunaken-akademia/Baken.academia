import unittest
import asyncio

from baken_academia.jra_all_odds_backfill import (
    parse_all_odds_cnames,
    merge_odds_cnames,
    parse_odds_cells,
    parse_odds_cname,
    parse_win_place_odds,
    fetch_odds_families,
)


class JraAllOddsBackfillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tail = "1009202604040120260913Z/36"

    def test_discovers_all_seven_pages_and_classifies_them(self) -> None:
        result = f"pw151ou{self.tail}".encode()
        kinds = (1, 3, 4, 5, 6, 7, 8)
        tabs = " ".join(
            f"pw15{kind}ou{self.tail.replace('Z/', 'Z99/') if kind == 7 else self.tail}"
            for kind in kinds
        ).encode()
        self.assertEqual(len(parse_all_odds_cnames(result)), 1)
        cnames = merge_odds_cnames(result, tabs)
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

    def test_same_day_navigation_stays_inside_requested_races(self):
        target = "pw151ouS306202604090120260927Z/AB"
        tab = "pw154ouS306202604090120260927Z/37"
        other_day = "pw151ou1006202604080120260926Z/B5"
        other_venue = "pw151ouS309202604090120260927Z/89"
        class Client:
            def __init__(self): self.requests = []
            async def fetch(self, name, endpoint):
                self.requests.append(name)
                return " ".join([target, tab, other_day, other_venue]).encode()
        client = Client()
        payloads = asyncio.run(fetch_odds_families(client, target.encode(), "test"))
        self.assertEqual(set(payloads), {target, tab})
        self.assertEqual(client.requests, [target, tab])
        self.assertEqual(parse_odds_cname(target)["course_code"], "06")
        self.assertEqual(parse_odds_cname(tab)["bet_type"], "quinella")


if __name__ == "__main__":
    unittest.main()
