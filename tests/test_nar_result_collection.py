import asyncio
import gzip
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import pandas as pd

from baken_academia.nar_backfill import backfill, Stats
from scripts.nar_partial_analysis import build_report


RESULT_URL = 'https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_raceDate=2019%2F01%2F01&k_raceNo=1&k_babaCode=19'
RESULT = '''<main><h4>2019年1月1日 船橋 第1競走 競走成績</h4>
<section class="raceTitle"><h3>試験</h3><ul class="dataArea"><li>ダート 1200ｍ（左） 天候：晴 馬場：良</li></ul></section>
<section class="gradeTable"><table><tr>
<td class="a">1</td><td class="b">2</td><td class="c">3</td>
<td class="horseName"><a href="/Horse?k_lineageLoginCode=101">馬</a></td>
<td class="jockeyName"><a href="/Jockey?k_riderLicenseNo=201">騎手</a></td>
<td><a class="trainerName" href="/Trainer?k_trainerLicenseNo=301">厩舎</a></td>
<td class="o">1</td><td class="p">3.4</td></tr></table></section>
<section class="newRefundTable"><table><tr><td class="title">単勝</td><td class="a">3</td><td class="refundMoney">340円</td><td class="c">1</td></tr></table></section></main>'''.encode()


class FakeClient:
    def __init__(self, *args):
        self.stats = Stats()
    async def __aenter__(self):
        return self
    async def __aexit__(self, *args):
        pass
    async def fetch(self, url):
        self.stats.network_requests += 1
        if 'MonthlyConveneInfoTop' in url:
            return b'<a href="/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2019%2F01%2F01&amp;k_babaCode=19">day</a>'
        if '/RaceList?' in url:
            return ('<a href="' + RESULT_URL.replace('&', '&amp;') + '">race</a>').encode()
        if '/RaceMarkTable?' in url:
            return RESULT
        if '/Odds' in url:
            return b'<main><table><tr><td>1-2</td><td>3.4</td></tr></table></main>'
        raise AssertionError('Unexpected request: ' + url)


class NarResultCollectionTest(unittest.TestCase):
    def test_light_collection_preserves_analysis_and_avoids_seven_requests(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            reports, frames, histories = [], [], []
            for mode in (False, True):
                data = root / str(mode)
                args = SimpleNamespace(permission_confirmed=True, year=2019, month=1,
                    start_day=1, end_day=15, min_delay=3, max_delay=3,
                    continue_on_error=False, max_races=None, include_all_bet_odds=mode,
                    output=data / 'nar-2019-01-a.parquet', work_dir=data / 'raw')
                with patch('baken_academia.nar_backfill.PoliteNarClient', FakeClient):
                    audit = asyncio.run(backfill(args))
                self.assertEqual(audit['network_requests'], 10 if mode else 3)
                self.assertEqual(audit['odds_pages'], 7 if mode else 0)
                self.assertEqual(audit['result_pages_found'], audit['races'])
                self.assertFalse(audit['errors'] or audit['odds_errors'])
                if not mode:
                    self.assertFalse(list(data.glob('*-odds-*.parquet')))
                    self.assertFalse(list(data.glob('*-payouts.parquet')))
                frames.append(pd.read_parquet(args.output))
                out = root / ('analysis-' + str(mode))
                reports.append(build_report(data, out))
                with gzip.open(out / 'nar-history-profile.json.gz', 'rt') as f:
                    histories.append(json.load(f))
            pd.testing.assert_frame_equal(frames[0], frames[1])
            for key in ('coverage','data_quality','market_baseline','by_popularity','by_racecourse','by_racecourse_distance','payout_summary','live_model'):
                self.assertEqual(reports[0][key], reports[1][key], key)
            self.assertEqual(histories[0], histories[1])

    def test_light_package_and_legacy_extraction_need_only_result_parquet(self):
        repo = Path(__file__).resolve().parents[1]
        def run_script(path, name):
            text = (repo / path).read_text()
            section = text.split('      - name: ' + name + '\n',1)[1].split('\n      - ',1)[0]
            return textwrap.dedent(section.split('        run: |\n',1)[1])
        package = run_script('.github/workflows/nar-backfill-8y.yml','Package verified NAR result archive')
        download = run_script('.github/workflows/nar-partial-analysis.yml','Download every completed NAR archive currently in Supabase')
        extract = next(line.strip() for line in download.splitlines() if line.strip().startswith('tar --no-same-owner'))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / 'data/raw/nar'
            data.mkdir(parents=True)
            (data / 'nar-2019-01-a.parquet').write_bytes(b'result')
            (data / 'nar-2019-01-a.audit.json').write_text('{}')
            env = {**os.environ, 'YEAR':'2019', 'MONTH_PADDED':'01', 'SUFFIX':'a', 'PERIOD':'20190101-20190115'}
            subprocess.run(['bash','-e','-c',package],cwd=root,env=env,check=True)
            archive = root / 'nar-20190101-20190115.tar.gz'
            with tarfile.open(archive) as tar:
                self.assertEqual(len(tar.getnames()),2)
            for name in ['nar-2019-01-a-odds-cells.parquet','nar-2019-01-a-payouts.parquet','events/event.jsonl.gz','odds-pages/odds.html.gz']:
                path = data / name
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(b'not needed')
            legacy = root / 'legacy.tar.gz'
            with tarfile.open(legacy,'w:gz') as tar:
                tar.add(data,arcname='data/raw/nar')
            for current in (archive,legacy):
                destination = root / '.nar-dataset'
                destination.mkdir(exist_ok=True)
                subprocess.run(['bash','-e','-c',extract],cwd=root,env={**env,'archive':str(current)},check=True)
                self.assertEqual([p.name for p in destination.rglob('*') if p.is_file()],['nar-2019-01-a.parquet'])


if __name__ == '__main__':
    unittest.main()
