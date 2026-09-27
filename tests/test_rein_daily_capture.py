import importlib.util
import unittest
from pathlib import Path
from datetime import datetime, timezone
from baken_academia.nar_backfill import filter_day_links
spec = importlib.util.spec_from_file_location('daily',Path(__file__).resolve().parents[1]/'scripts/rein_daily_capture.py')
daily=importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)

class DailyCaptureTest(unittest.TestCase):
    def test_date_boundary_and_future_rejection(self):
        night=datetime(2026,9,27,13,35,tzinfo=timezone.utc)
        morning=datetime(2026,9,27,21,35,tzinfo=timezone.utc)
        self.assertEqual(str(daily.capture_date(None,night)),'2026-09-27')
        self.assertEqual(str(daily.capture_date(None,morning)),'2026-09-27')
        with self.assertRaises(ValueError): daily.capture_date('2026-09-28',night)
        with self.assertRaises(ValueError): daily.capture_date('2026-09-01',night)
        with self.assertRaises(ValueError): daily.capture_date('2026-09-28',morning)
    def test_nar_filters_venue_days_before_fetching(self):
        urls=[f'https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2026%2F09%2F{d}&k_babaCode=3' for d in ['01','02','27','28']]
        self.assertEqual(filter_day_links(urls,27,27),[urls[2]])
        self.assertEqual(filter_day_links(urls,None,None),urls)
        self.assertEqual(filter_day_links(urls,27,28),urls[2:])
