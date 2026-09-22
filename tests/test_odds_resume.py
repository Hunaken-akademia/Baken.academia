import io
import json
import tarfile
import tempfile
import unittest
from datetime import date
from pathlib import Path

from scripts.plan_all_odds_resume import periods
from scripts.plan_nar_resume import build_periods
from scripts.validate_jra_archive import validate


class ResumeTests(unittest.TestCase):
    def test_jra_period_plan(self):
        planned = periods()
        self.assertEqual(len(planned), 202)
        self.assertEqual(planned[0]["name"], "20190101-20190114")
        self.assertEqual(planned[-1]["name"], "20260915-20260918")

    def test_empty_jra_date_windows_are_excluded(self):
        planned = periods({date(2026, 9, 13)})
        self.assertEqual(len(planned), 1)
        self.assertEqual(planned[0]["name"], "20260901-20260914")

    def test_nar_half_month_plan(self):
        planned = build_periods()
        self.assertEqual(len(planned), 186)
        self.assertEqual(planned[0]["period"], "20190101-20190115")
        self.assertEqual(planned[-1]["period"], "20260916-20260930")

    def test_archive_validation(self):
        for payload, expected in [
            ({}, False),
            ({"audit.json": json.dumps({"errors": []}).encode(), "pages.parquet": b"PAR1"}, True),
            ({"audit.json": json.dumps({"errors": ["fetch failed"]}).encode(), "pages.parquet": b"PAR1"}, False),
        ]:
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


if __name__ == "__main__":
    unittest.main()
