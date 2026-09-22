import io
import json
import tarfile
import tempfile
import unittest
from datetime import date
from pathlib import Path
from scripts.plan_all_odds_resume import JOB, periods
from scripts.validate_jra_archive import validate


class ResumeTests(unittest.TestCase):
    def test_completed_windows_are_not_retried(self):
        self.assertEqual(len(periods(set())), 202)
        self.assertEqual(len(periods({"20190101-20190114"})), 201)
        self.assertEqual(JOB.match("collect (20190101-20190114, 2019-01-01, 2019-01-14)")[1], "20190101-20190114")

    def test_empty_date_windows_are_excluded(self):
        self.assertEqual(len(periods(set(), {date(2026, 9, 13)})), 1)
        self.assertEqual(periods(set(), {date(2026, 9, 13)})[0]["name"], "20260901-20260914")

    def test_archive_validation(self):
        for payload, expected in [({}, False),
                                  ({"audit.json": json.dumps({"errors": []}).encode(), "pages.parquet": b"PAR1"}, True),
                                  ({"audit.json": json.dumps({"errors": ["fetch failed"]}).encode(), "pages.parquet": b"PAR1"}, False)]:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "data.tar.gz"
                with tarfile.open(path, "w:gz") as archive:
                    for name, value in payload.items():
                        member = tarfile.TarInfo("data/raw/jra-all-odds/normalized/" + name)
                        member.size = len(value)
                        archive.addfile(member, io.BytesIO(value))
                if expected:
                    validate(path)
                else:
                    with self.assertRaises(ValueError):
                        validate(path)
