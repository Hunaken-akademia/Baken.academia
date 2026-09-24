import unittest

from baken_academia.jra_backfill import (
    parse_all_results_cname,
    parse_event_cnames,
    parse_current_year_month,
    parse_month_checksums,
    parse_results_page,
)


class JraBackfillTest(unittest.TestCase):
    def test_discovers_navigation_cnames(self) -> None:
        page = b'''<script>objParam["2609"]="BA"; var yearMonth = "202609";</script>
        <a onclick="return doAction('/JRADB/accessS.html', 'pw01srl10062026040420260913/75');">day</a>
        <a onclick="return doAction('/JRADB/accessS.html', 'pw01ses10062026040420260913/7E');">all</a>'''
        self.assertEqual(parse_month_checksums(page), {"2609": "BA"})
        self.assertEqual(parse_current_year_month(page), 202609)
        self.assertEqual(parse_event_cnames(page), ["pw01srl10062026040420260913/75"])
        self.assertEqual(parse_all_results_cname(page), "pw01ses10062026040420260913/7E")

    def test_parses_runner_and_race_fields(self) -> None:
        page = '''<!doctype html><html><body>
        <div class="race_result_unit" id="race_result_2R">
          <table class="basic narrow-xy striped">
            <caption>
              <div class="race_header"><div class="date_line"><div class="cell date">2026年9月13日（日曜） 4回中山4日</div><div class="cell time"><strong>10時35分</strong></div><li class="weather"><span class="cap">天候</span><span class="txt">曇</span></li><li class="turf"><span class="cap">芝</span><span class="txt">重</span></li></div>
              <div class="race_title"><span class="race_name">2歳未勝利</span><div class="cell category">2歳</div><div class="cell class">未勝利</div><div class="cell rule">（混合）</div><div class="cell weight">馬齢</div><div class="cell course">コース：2,000メートル（芝・右）</div></div></div>
            </caption>
            <tbody><tr><td class="place">1</td><td class="waku"><img alt="枠4青"></td><td class="num">4</td><td class="horse"><a href="/JRADB/accessU.html?CNAME=pw01dud102021109096/DA">モナコブル</a><img alt="ブリンカー着用"></td><td class="age">牡5</td><td class="weight">57.0</td><td class="jockey"><a onclick="doAction('/JRADB/accessK.html','pw04kmk001069/9C')">騎手</a></td><td class="time">2:01.2</td><td class="margin"></td><td class="corner"><li>3</li><li>2</li></td><td class="f_time">12.1</td><td class="h_weight">470<span>(+2)</span></td><td class="trainer"><a onclick="doAction('/JRADB/accessC.html','pw05cmk001051/14')">調教師</a></td><td class="pop">2</td></tr></tbody>
          </table>
          <table class="basic narrow"><tr><th>ハロンタイム</th><td>12.0 - 11.9</td></tr><tr><th>上り</th><td>4F 47.8 - 3F 36.0</td></tr></table>
        </div></body></html>'''.encode("cp932")
        rows = parse_results_page(page, "sample")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["race_id"], "20260913-中山-02")
        self.assertEqual(rows[0]["horse_id"], "2021109096")
        self.assertEqual(rows[0]["surface"], "芝")
        self.assertEqual(rows[0]["horse_weight_change"], 2)
        self.assertEqual(rows[0]["race_last_3f"], 36.0)
        self.assertTrue(rows[0]["blinkers"])


if __name__ == "__main__":
    unittest.main()
