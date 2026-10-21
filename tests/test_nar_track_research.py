import json

import pandas as pd

from scripts.nar_track_research import analyze, parse_kochi_post, prior_styles
from scripts.enrich_nar_track_corners import merge_corners


def post(text, title="2026年10月18日の馬場状態"):
    return {"id": 1, "link": "https://www.keiba.or.jp/?p=1", "date": "2026-10-18T12:30:00", "modified": "2026-10-18T12:30:00", "title": {"rendered": title}, "content": {"rendered": "<p>" + text + "</p>"}}


def test_real_format_depth_units_and_publication_time():
    text = "2026年10月18日 11時30分 現在 馬場状態 稍重\n" + "\n".join(label + "14.5-14-12.5-12" for label in ("1から2コーナー", "向正面（バック）", "3から4コーナー", "正面（ホーム）"))
    row = parse_kochi_post(post(text))
    assert row["cushion"] is None
    assert row["inner_mean_cm"] == 14.5
    assert row["outer_mean_cm"] == 12.25
    assert row["inner_outer_gap_cm"] == 2.25
    assert row["available_after"] == "2026-10-18T12:30:00+09:00"
    assert row["going_at_measurement"] == "稍重"


def test_missing_segment_and_management_target_are_not_measurements():
    assert parse_kochi_post(post("含水率3〜5%を目標に散水。砂厚12cm。")) is None
    assert parse_kochi_post(post("1から2コーナー14-13-12-11")) is None
    assert parse_kochi_post(post("馬場状態 重", "馬場状態の変更 第2競走以降")) is None


def test_prior_styles_exclude_current_and_same_day_results():
    rows = []
    for day, rank in (("2025-01-01", 1), ("2025-01-02", 1), ("2025-01-03", 9), ("2025-01-03", 8), ("2025-01-04", 9)):
        rid = str(len(rows))
        for n in range(1, 10):
            rows.append(dict(race_id=rid, race_date=day, horse_id="target" if n == 1 else f"other{n}", horse_number=n, corner_positions=f"{rank}-2-3-4" if n == 1 else "4-5-6-7"))
    result = prior_styles(pd.DataFrame(rows))
    target = result.loc[result.horse_id.eq("target")]
    assert list(target.prior_style) == ["unknown", "unknown", "front", "front", "middle"]
    changed = pd.DataFrame(rows)
    changed.loc[changed.race_date.ge("2025-01-03"), "corner_positions"] = "9-9-9-9"
    alternative = prior_styles(changed)
    assert list(alternative.loc[alternative.horse_id.eq("target") & alternative.race_date.eq("2025-01-03"), "prior_style"]) == ["front", "front"]


def test_unparsed_corner_order_stays_unknown():
    frame = pd.DataFrame([dict(race_id=str(i), race_date=f"2025-01-0{i+1}", horse_id="a", horse_number=1, corner_positions=None) for i in range(3)])
    assert set(prior_styles(frame).prior_style) == {"unknown"}


def test_old_title_uses_explicit_body_date_and_whole_hour():
    text = "2021年2月9日 12時現在 馬場状態 稍重\n" + "\n".join(label + "14-13-12-11" for label in ("1から2コーナー", "向正面（バック）", "3から4コーナー", "正面（ホーム）"))
    row = parse_kochi_post(post(text, "2月9日の馬場状態"))
    assert row["date"] == "2021-02-09"
    assert row["measured_at"] == "2021-02-09T12:00:00+09:00"


def test_join_does_not_forward_fill_and_unknown_styles_are_excluded(tmp_path):
    source = tmp_path / "input"
    source.mkdir()
    rows = []
    for i, day in enumerate(("2024-12-01", "2024-12-08", "2025-01-01", "2026-01-01")):
        for n in range(1, 10):
            rows.append(dict(race_id=str(i), race_date=day, horse_id=str(n), horse_number=n,
                             corner_positions=f"{n}-3-4-5", baba_code="31", finish_position=n, going="良"))
    pd.DataFrame(rows).to_parquet(source / "nar-test.parquet")
    measurement = {"date": "2025-01-01", "published_at": "2025-01-01T12:00:00+09:00", "inner_outer_gap_cm": 2.5}
    path = tmp_path / "measurements.json"
    path.write_text(json.dumps([measurement]))
    report = analyze(source, path, tmp_path / "out")
    assert report["kochi_races"] == 4
    assert report["matched_races"] == 1
    assert report["known_prior_style_starts"] == 9
    assert report["production_applied"] is False
    assert all(g["period"] == "2025" for g in report["groups"])


def test_enrichment_requires_same_horse_date_and_race_and_keeps_outcome():
    frame = pd.DataFrame([dict(horse_number=1, horse_id="a", race_date="2026-01-01", race_no=1, corner_positions=None, finish_position=3)])
    record = dict(horse_number=1, horse_id="wrong", race_date="2026-01-01", race_no=1, corner_positions="1-2-3-4", finish_position=1)
    result, count = merge_corners(frame, [record])
    assert count == 0
    record["horse_id"] = "a"
    record["race_date"] = "2026-01-02"
    assert merge_corners(frame, [record])[1] == 0
    record["race_date"] = "2026-01-01"
    result, count = merge_corners(frame, [record])
    assert count == 1
    assert result.iloc[0].corner_positions == "1-2-3-4"
    assert result.iloc[0].finish_position == 3


def test_unparsed_enrichment_does_not_invent_passing_positions():
    frame = pd.DataFrame([dict(horse_number=1, horse_id="a", race_date="2026-01-01", race_no=1, corner_positions=None)])
    record = dict(horse_number=1, horse_id="a", race_date="2026-01-01", race_no=1, corner_positions="(1,2)-3")
    assert merge_corners(frame, [record])[1] == 0
