import unittest
from baken_academia.nar_backfill import parse_result_links, parse_result_page, parse_schedule_links


class NarBackfillTest(unittest.TestCase):
    def test_links(self):
        schedule = b'<a href="/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2019%2F01%2F01&amp;k_babaCode=3">x</a>'
        listing = b'<a href="/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_raceDate=2019%2F01%2F01&amp;k_raceNo=1&amp;k_babaCode=3">x</a>'
        self.assertEqual(len(parse_schedule_links(schedule)), 1)
        self.assertEqual(len(parse_result_links(listing)), 1)

    def test_result(self):
        payload = '''<main><h4>2019年1月1日（火） 帯 広 第1競走 <span>競走成績</span></h4>
        <section class="raceTitle"><h3>テスト競走</h3><ul class="dataArea"><li>ダート 1400ｍ（右） 天候：晴 馬場：良</li></ul></section>
        <section class="gradeTable"><table><tr><td class="a">1</td><td class="b">2</td><td class="c">3</td>
        <td class="d horseName"><a href="/KeibaWeb/DataRoom/HorseMarkInfo?k_lineageLoginCode=H1">テスト馬</a></td>
        <td class="e">北海道</td><td class="f">牡 4</td><td class="g">56</td>
        <td class="h jockeyName"><a href="/KeibaWeb/DataRoom/RiderMark?k_riderLicenseNo=J1">騎手A</a></td>
        <td class="i"><a class="trainerName" href="/KeibaWeb/DataRoom/TrainerMark?k_trainerLicenseNo=T1">調教師A</a></td>
        <td class="j horseWeight">480<span>(2)</span></td><td class="k">1:25.0</td><td class="l"></td><td class="m">38.1</td><td class="o">2</td><td class="p">3.4</td>
        </tr></table></section></main>'''.encode()
        url = "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_raceDate=2019%2F01%2F01&k_raceNo=1&k_babaCode=3"
        row = parse_result_page(payload, url)[0]
        self.assertEqual(row["horse_id"], "H1")
        self.assertEqual(row["race_id"], "20190101-NAR-3-01")
        self.assertEqual(row["distance_m"], 1400)
        self.assertEqual(row["horse_weight_change"], 2)


if __name__ == "__main__": unittest.main()
