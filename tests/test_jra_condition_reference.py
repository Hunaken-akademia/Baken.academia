from __future__ import annotations

import json

import pandas as pd

from scripts.jra_condition_reference import build, grade_from_row, official_grade_schedule, race_name_key, runner_first_corner


def test_grade_name_and_corner_parsing_are_strict_enough():
    assert grade_from_row(pd.Series({"race_class": "ＧⅢ"})) == "G3"
    assert grade_from_row(pd.Series({"race_category": "G1"})) == "G1"
    assert grade_from_row(pd.Series({"race_class": "3勝クラス"})) is None
    assert race_name_key("第60回 スプリンターズステークス（GⅠ）") == "スプリンターズS"
    assert race_name_key("スプリンターズステークス") == race_name_key("スプリンターズS")
    assert race_name_key("東京優駿（日本ダービー）") == race_name_key("東京優駿")
    assert race_name_key("アメリカジョッキークラブカップ") == race_name_key("AJCC")
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


def test_official_schedule_recovers_image_only_grades(tmp_path):
    (tmp_path / "2026.html").write_text("""<table><tr><td>9月30日水曜</td><td><img alt="GⅢ">テスト記念</td><td>中山</td><td>3歳以上</td><td>芝1,200メートル</td></tr></table>""")
    schedule = official_grade_schedule(tmp_path)
    assert schedule["2026-09-30|中山|芝|1200|テスト記念"] == ("G3", "テスト記念")


def test_official_schedule_fuzzy_match_keeps_unrelated_same_condition_ungraded():
    schedule = {"2026-05-31|東京|芝|2400|東京優駿日本ダービー": ("G1", "東京優駿（日本ダービー）")}
    rows = []
    for race_id, name in (("grade", "東京優駿"), ("ordinary", "青嵐賞")):
        for number in (1, 2, 3):
            rows.append({"race_id": race_id, "race_date": "2026-05-31", "racecourse": "東京", "race_name": name,
                         "race_class": "", "race_category": "", "surface": "芝", "distance_m": 2400, "going": "良",
                         "horse_id": f"{race_id}-{number}", "horse_number": number, "gate": number,
                         "popularity": number, "finish_position": number, "corner_positions": json.dumps([str(number)])})
    races = __import__("scripts.jra_condition_reference", fromlist=["summarize_races"]).summarize_races(pd.DataFrame(rows), schedule)
    assert races.set_index("race_id").loc["grade", "grade"] == "G1"
    assert pd.isna(races.set_index("race_id").loc["ordinary", "grade"])


def test_graded_history_rejects_duplicate_same_year_titles():
    rows = []
    for year in range(2021, 2027):
        repeats = 2 if year == 2025 else 1
        for repeat in range(repeats):
            for number in (1, 2, 3):
                rows.append({
                    "race_id": f"{year}-duplicate-{repeat}", "race_date": f"{year}-09-{20 + repeat:02d}",
                    "racecourse": "中山", "race_name": "重複記念", "race_class": "GIII",
                    "race_category": "重賞", "surface": "芝", "distance_m": 1200, "going": "良",
                    "horse_id": f"{year}-{repeat}-{number}", "horse_number": number, "gate": number,
                    "popularity": number, "finish_position": number, "corner_positions": json.dumps([str(number)]),
                })
    payload = build(pd.DataFrame(rows), minimum_races=999, minimum_editions=5)
    assert payload["gradedRaces"] == []
