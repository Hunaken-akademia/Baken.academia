from __future__ import annotations

import gzip
import json

import pandas as pd

from baken_academia.rein_history import build


def test_build_rein_history_profile(tmp_path):
    rows = []
    for day, finish in enumerate([4, 3, 2, 1, 2, 1], start=1):
        rows.append({
            "race_id": f"r{day}",
            "race_date": f"2026-01-{day:02d}",
            "horse_number": 1,
            "horse_id": "000123",
            "jockey_id": "0010",
            "trainer_id": "0020",
            "finish_position": finish,
            "surface": "芝",
            "distance_m": 1600,
            "racecourse": "東京",
            "going": "良",
            "gate": 1,
        })
    source = tmp_path / "races.parquet"
    output = tmp_path / "history.json.gz"
    pd.DataFrame(rows).to_parquet(source, index=False)

    meta = build(source, output)

    with gzip.open(output, "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    assert meta["races"] == 6
    assert payload["horse"]["123"]["n"] == 6
    assert payload["horseRecent5"]["123"]["n"] == 5
    assert payload["horseDistance"]["123|8"]["n"] == 6
