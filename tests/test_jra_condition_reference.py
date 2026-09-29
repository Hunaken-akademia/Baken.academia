from __future__ import annotations

import json

import pandas as pd

from scripts.jra_condition_reference import build, grade_from_row, race_name_key, runner_first_corner


def test_grade_name_and_corner_parsing_are_strict_enough():
    assert grade_from_row(pd.Series({"race_class": "ＧⅢ"})) == "G3"
    assert grade_from_row(pd.Series({"race_category": "G1"})) == "G1"
    assert grade_from_row(pd.Series({"race_class": "3勝クラス"})) is None
    assert race_name_key("第60回 スプリンターズステークス（GⅠ）") == "スプリンターズステークス"
    assert runner_first_corner(json.dumps(["3", "3", "2"])) == 3
    assert runner_first_corner("not-json") is None


def test_build_requires_both_years_for_conditions_and_five_distinct_graded_editions():
    rows = []
    for year in range(2021, 2027):
        for number, popularity, finish in ((1, 1, 1), (2, 5, 2), (3, 10, 3)):
            rows.append({
                "race_id": f"{year}-grade", "race_date": f"{year}-09-30", "racecourse": "中山",
                "race_name": "テスト記念", "race_class": "GIII", "race_category": "重賞",
                "surface": "芝", "distance_m": 1200, "going": "良", "horse_id": f"{year}-{number}",
                "horse_number": number, "gate": number, "popularity": popularity, "finish_position": finish,
                "corner_positions": json.dumps([str(number)]),
            })
    # Add enough ordinary races in selection and audit for every condition kind.
    for year in (2025, 2026):
        for race in range(2):
            for number in (1, 2, 3):
                rows.append({
                    "race_id": f"{year}-ordinary-{race}", "race_date": f"{year}-01-{race+1:02d}", "racecourse": "中山",
                    "race_name": "一般", "race_class": "1勝クラス", "race_category": "一般", "surface": "芝",
                    "distance_m": 1200, "going": "良", "horse_id": f"o-{year}-{race}-{number}", "horse_number": number,
                    "gate": number, "popularity": number, "finish_position": number, "corner_positions": json.dumps([str(number)]),
                })
    payload = build(pd.DataFrame(rows), minimum_races=3, minimum_editions=5)
    assert len(payload["conditions"]) == 3
    assert payload["conditions"][0]["audit"]["favoriteWinner"]["rate"] == 1.0
    assert len(payload["gradedRaces"]) == 1
    assert len(payload["gradedRaces"][0]["editions"]) == 6
    assert payload["gradedRaces"][0]["key"] == "テスト記念"
