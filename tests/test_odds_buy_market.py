import sys,unittest,itertools
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import numpy as np
from odds_buy_market import parse_jra,parse_nar,odds_range,market_probabilities,payout_key
class OddsBuyTest(unittest.TestCase):
 def test_jra_ordered_and_unordered_keep_real_headers(self):
  page='<li><div class="p_line"><div class="num">4</div></div><div class="p_line"><div class="num">2</div></div><table class="basic tan3"><tbody><tr><th>3</th><td>25.7</td></tr><tr><th>4</th><td>取消</td></tr></tbody></table></li>'.encode('cp932')
  self.assertEqual(parse_jra(page,'trifecta'),{'trifecta':{(4,2,3):(25.7,25.7)}})
  page=b'<table class="fuku3"><caption>2-4</caption><tr><th>7</th><td>10.2</td></tr></table>'
  self.assertEqual(parse_jra(page,'trio')['trio'],{(2,4,7):(10.2,10.2)})
 def test_nar_real_combinations_are_not_matrix_coordinates(self):
  page='<table><tr><th>組合せ</th><th>オッズ</th></tr><tr><td>11-2-4</td><td>20.9</td><td>8</td></tr><tr><td>11-4-2</td><td>0.0</td><td>9</td></tr></table>'.encode()
  self.assertEqual(parse_nar(page,'trifecta'),{'trifecta':{(11,2,4):(20.9,20.9)}})
  self.assertFalse(parse_nar('ご指定のオッズの情報がありません'.encode(),'trio'))
 def test_ranges_and_cancellations(self):
  self.assertEqual(odds_range('1.2 - 1.8'),(1.2,1.8));self.assertIsNone(odds_range('取消'));self.assertIsNone(odds_range('0.0'));self.assertIsNone(odds_range('1.8-1.2'))
 def test_nar_ordered_frame_section_is_separate(self):
  page=b'<li><ul class="odd_horse_number_list"><li><table><tr><th>1</th></tr><tr><td>2</td><td>2.1</td></tr></table></li></ul><div><h4>\xe6\x9e\xa0\xe9\x80\xa3\xe5\x8d\x98</h4></div><ul class="odd_horse_number_list"><li><table><tr><th>1</th></tr><tr><td>2</td><td>3.1</td></tr></table></li></ul></li>'
  self.assertEqual(set(parse_nar(page,'bracket_quinella')),{'bracket_quinella','bracket_exacta'})
 def test_probability_mass_respects_two_place_races(self):
  win={1:2.,2:3.,3:6.};gate={1:1,2:2,3:3}
  for bet,sels,target in [('win',[(1,),(2,),(3,)],1),('place',[(1,),(2,),(3,)],3),('exacta',list(itertools.permutations(win,2)),1),('trifecta',list(itertools.permutations(win,3)),1),('trio',[(1,2,3)],1),('wide',list(itertools.combinations(win,2)),3)]:self.assertAlmostEqual(market_probabilities(win,bet,sels,gate).sum(),target)
  self.assertAlmostEqual(market_probabilities(win,'place',[(1,),(2,),(3,)],gate,2).sum(),2)
 def test_settlement_uses_official_payout_and_preserves_order(self):
  row={'race_id':'r','bet_type':'馬連単','combination':'4-2','payout_yen':790}
  self.assertEqual(payout_key(row,'nar'),('r','exacta',(4,2),790.))
  row['bet_type']='馬連複';self.assertEqual(payout_key(row,'nar'),('r','quinella',(2,4),790.))
  row['combination']='返還';self.assertIsNone(payout_key(row,'nar'))
if __name__=='__main__':unittest.main()
