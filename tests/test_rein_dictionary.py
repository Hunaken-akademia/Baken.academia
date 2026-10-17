import unittest
import pandas as pd
from scripts.build_rein_dictionary import prepare, aggregate, shard_key, nar_graded_identity

class DictionaryTests(unittest.TestCase):
    def frame(self):
        rows=[]
        for i,(finish,status,horse) in enumerate([(1,'1','001'),(2,'2','002'),(None,'取消','003'),(None,'中止','004'),(1,'1','005')]):
            rows.append(dict(race_id='race',race_date='2026-01-01',horse_number=i+1,horse_id=horse,horse_name='馬'+horse,jockey_id='010',jockey_name='騎手',trainer_id='020',trainer_name='厩舎',finish_position=finish,finish_status=status,racecourse='崎',baba_code='21',race_name='記念',surface='ダート',distance_m=1600,going='良',gate=1,popularity=i+1))
        return pd.DataFrame(rows)
    def test_starts_dead_heats_cancellation_and_missing_position(self):
        d,a=prepare(self.frame(),'nar','2026-01-01')
        self.assertEqual(len(d),4);self.assertEqual(a['excludedRows'],1)
        self.assertEqual(d.venue.unique().tolist(),['川崎']);self.assertEqual(d.position.unique().tolist(),['記録なし'])
        p=aggregate(d,'jockey')['10'];self.assertEqual(p['counts'],[4,2,3,3]);self.assertEqual(p['groups']['venue']['川崎'],[4,2,3,3])
    def test_future_unsettled_and_banei_are_not_included(self):
        base=self.frame();later=base.copy();later['race_id']='future';later['race_date']='2026-01-02'
        banei=base.copy();banei['race_id']='banei';banei['baba_code']='3'
        no_winner=base.copy();no_winner['race_id']='void';no_winner['finish_position']=None;no_winner['finish_status']='取消'
        d,_=prepare(pd.concat([base,later,banei,no_winner]),'nar','2026-01-01')
        self.assertEqual(set(d.race_id),{'race'})
    def test_ids_do_not_merge_names_and_groups_reconcile(self):
        d,_=prepare(self.frame(),'nar','2026-01-01');d['horseName']='同名'
        profiles=aggregate(d,'horse');self.assertEqual(len(profiles),4)
        for p in profiles.values():
            for group in p['groups'].values():self.assertEqual([sum(c[i] for c in group.values()) for i in range(4)],p['counts'])
        self.assertEqual(len(shard_key('horse:1')),1)
    def test_grade_titles_do_not_match_promotions_or_english_words(self):
        names=['東京大賞典','帝王賞','エンプレス杯']
        self.assertEqual(nar_graded_identity('第７１回 東京大賞典ＧＩ３上選定馬重賞',names),('東京大賞典','G1'))
        self.assertEqual(nar_graded_identity('第７２回 エンプレス杯キヨフジ記念【指定交流】JpnII４歳上牝馬',names),('エンプレス杯','Jpn2'))
        for name in ['ＮｅｗＢｅｇｉｎｎｉｎｇ ２歳初出走','２０１１ 東京大賞典国際ＧⅠ格付け賞３歳','旅うまリレー今日は船橋でＪｐｎII賞Ｃ３','日刊ゲンダイＤＩＧＩＴＡＬ賞Ｂ２']:
            self.assertIsNone(nar_graded_identity(name,names))
    def test_duplicate_rows_are_counted_once(self):
        frame=self.frame();d,_=prepare(pd.concat([frame,frame]),'nar','2026-01-01');self.assertEqual(len(d),4)

if __name__=='__main__':unittest.main()
