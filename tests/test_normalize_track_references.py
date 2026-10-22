from scripts.normalize_track_references import document, parse_hyogo, parse_iwate, parse_jra_fragment, parse_specification, publication


def test_iwate_target_forecast_and_adjustment_are_distinct():
    text = "■ ダート走路について\n砂厚を10cm~11cmに調整しました。\n含水率3~5%を目標として散水します。\n■ 芝走路について\n芝高は10cm~12cmの見込みです。\nお知らせ一覧\n砂厚を99cm~100cmに調整しました。"
    rows = parse_iwate(text, "第7回盛岡競馬 走路状況", "2026-08-23")
    assert [r["kind"] for r in rows[:3]] == ["adjustment_notice", "management_target", "forecast"]
    assert all(r["effective_date"] is None and r["measured_at"] is None for r in rows)
    assert not any(r.get("value_min") == 99 for r in rows)


def test_hyogo_profile_has_correct_distances_and_no_forward_fill():
    text = "【2026年1月19日(月)16時00分現在】内ラチから1m、3m、5m、7m、10m地点の砂厚 ≪1コーナー≫14-11-11-11-11"
    rows = parse_hyogo(text, "姫路", "2026-01-19")
    assert [(r["distance_from_inner_m"], r["value"]) for r in rows] == [(1,14),(3,11),(5,11),(7,11),(10,11)]
    assert all(r["as_of_date"] == "2026-01-19" and r["effective_date"] is None for r in rows)
    assert parse_hyogo(text.replace("地点の砂厚", "地点の砂圧"), "姫路", "2026-01-19") == []


def test_jra_fragment_preserves_unknown_year_and_excludes_missing_cells():
    raw = '<div id="rcA" title="東京"><div class="unit"><div class="time">10月18日(日曜)7時00分</div><div class="cushion">9.2</div></div><div class="unit"><div class="cushion">-</div></div></div>'.encode("cp932")
    rows = parse_jra_fragment(document(raw))
    assert len(rows) == 1
    assert rows[0]["venue"] == "東京" and rows[0]["value"] == 9.2
    assert rows[0]["measured_at"] is None and not rows[0]["year_verified"]


def test_publication_is_not_derived_from_sidebar_or_url():
    raw = '<html><time datetime="2026-08-23">2026年8月23日</time></html>'.encode()
    assert publication(document(raw), "") == "2026-08-23"
    assert publication(document(b"<p>archive</p>"), "2026年\n2025年\n11月11日に調整") is None


def test_specification_does_not_take_previous_value_as_current():
    rows = parse_specification("砂 厚\n12.0cm(従来は 10.0cm)", "船橋", "2022-03-07")
    assert rows[0]["value_min"] == 12
    assert rows[0]["kind"] == "announced_specification" and rows[0]["effective_date"] is None


def test_specification_range_and_mean_are_kept_as_stated():
    row = parse_specification("砂 厚 9.0cm~10.0cm(従来と同様)", "浦和", "2021-12-13")[0]
    assert (row["value_min"], row["value_max"]) == (9,10)
    row = parse_specification("砂厚を調整(平均12.0cm)しました。", "門別", None)[0]
    assert row["value_min"] == 12 and row["publication_date"] is None


def test_reversed_source_range_is_not_silently_corrected():
    import pytest
    with pytest.raises(ValueError, match="Invalid reported range"):
        parse_iwate("■ ダート走路について\n砂厚を11cm~10cmに調整しました。", "水沢競馬 走路状況", "2025-12-20")
