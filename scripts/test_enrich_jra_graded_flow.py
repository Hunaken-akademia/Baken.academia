"""Regression tests for official result association and missing-data handling."""
import unittest
from lxml import html
from scripts.enrich_jra_graded_flow import parse_result, schedule_links

EDITION = {"date":"2025-10-05","venue":"東京","surface":"芝","distanceM":1800,"going":"良","fieldSize":11}
URL = "https://www.jra.go.jp/datafile/seiseki/replay/2025/090.html"
# Minimal structural fixture: values test parsing, not historical results.
MARKUP = '''<html><div class="date_line"><div class="cell date">2025年10月5日（日曜） 4回東京2日</div><div class="cell baba"><li class="turf"><span class="txt">良</span></li></div></div><div class="cell course">コース：1,800メートル（芝・左）</div><table><tr><td class="place">1</td><td class="num">9</td><td class="horse">検証馬</td><td class="corner"><li title="2コーナー通過順位">3</li><li title="3コーナー通過順位">2</li></td></tr><tr><th>ハロンタイム</th><td>12.7 - 10.8 - 11.3 - 11.9 - 11.9 - 11.7 - 11.2 - 11.1 - 11.4</td></tr></table><footer>京都 中山 2024年10月5日</footer></html>'''

MARKUP = MARKUP.replace("</table>", "".join(f'<tr><td class="place">{i}</td><td class="num">{i}</td><td class="horse">検証馬{i}</td><td class="corner"></td></tr>' for i in [2,3,4,5,6,7,8,10,11,12]) + "</table>")

class OfficialFlowTest(unittest.TestCase):
    def test_actual_laps_and_corner_labels(self):
        value=parse_result(html.fromstring(MARKUP),EDITION,URL)
        self.assertEqual(value['runners'][0]['corners'],[3,2])
        self.assertEqual(value['runners'][0]['stages'],['2コーナー通過順位','3コーナー通過順位'])
        self.assertEqual(len(value['laps']),9)
        self.assertEqual(value['sourceUrl'],URL)
    def test_wrong_date_venue_surface_distance_and_going_rejected(self):
        for update in [{'date':'2024-10-05'},{'venue':'京都'},{'surface':'ダート'},{'distanceM':1600},{'going':'重'}]:
            with self.subTest(update=update),self.assertRaises(ValueError):
                parse_result(html.fromstring(MARKUP),dict(EDITION,**update),URL)
    def test_incomplete_laps_are_held_and_invalid_position_rejected(self):
        value=parse_result(html.fromstring(MARKUP.replace(' - 11.4','')),EDITION,URL)
        self.assertEqual(value['laps'],[])
        with self.assertRaises(ValueError):
            parse_result(html.fromstring(MARKUP.replace('>3</li>','>12</li>')),EDITION,URL)
    def test_dnf_is_a_starter_but_withdrawal_is_not(self):
        value = MARKUP.replace('</table>', '<tr><td class="place">中止</td><td class="num">13</td></tr><tr><td class="place">取消</td><td class="num">14</td></tr></table>')
        self.assertEqual(parse_result(html.fromstring(value),EDITION,URL)['fieldSize'],12)
    def test_schedule_duplicate_condition_is_not_guessed(self):
        row='<tr><td>10月5日</td><td>検証重賞</td><td>東京</td><td>GII</td><td>芝1,800</td><td>3歳以上</td><td>別定</td><td><a href="/datafile/seiseki/replay/2025/090.html">レース結果</a></td></tr>'
        self.assertEqual(schedule_links(html.fromstring('<table>'+row+row+'</table>'),2025),{})
        self.assertEqual(list(schedule_links(html.fromstring('<table>'+row+'</table>'),2025).values()),[URL])

if __name__=='__main__':unittest.main()
