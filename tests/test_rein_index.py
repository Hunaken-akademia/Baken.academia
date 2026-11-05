import numpy as np
import pandas as pd

from baken_academia.rein_index import add_index_features, build_rein_index, finish_seconds


def _race(race_id, date, times, horses, venue="東京", surface="芝", distance=1600, cls="2勝クラス"):
    return [
        {"race_id": race_id, "race_date": date, "racecourse": venue, "surface": surface,
         "distance_m": distance, "race_class": cls, "age": 4, "weight_carried": 56.0,
         "horse_id": horse, "finish_position": i + 1, "finish_time": t, "horse_number": i + 1}
        for i, (t, horse) in enumerate(zip(times, horses))
    ]


def _history(days=40):
    rows = []
    for d in range(days):
        date = (pd.Timestamp("2024-01-06") + pd.Timedelta(days=int(7 * d))).strftime("%Y-%m-%d")
        for r in range(3):
            base = 94.0 + 0.3 * (d % 3)  # some days are faster than others
            rows += _race(f"{d:03d}{r}", date, [f"1:{base - 60 + k * 0.2:.1f}" for k in range(6)],
                          [f"h{d}-{r}-{k}" for k in range(6)])
    return pd.DataFrame(rows)


def test_finish_seconds_parses_minutes_and_rejects_text():
    parsed = finish_seconds(pd.Series(["1:34.5", "58.9", "中止", None]))
    assert parsed.iloc[0] == 94.5 and parsed.iloc[1] == 58.9
    assert parsed.iloc[2:].isna().all()


def test_variant_removes_day_speed_and_rates_finishers_in_order():
    rated = build_rein_index(_history())
    assert rated["rein_index"].notna().all()
    # Each winner on fast and slow days gets a similar adjusted index.
    winners = rated.loc[rated.finish_position.eq(1)]
    # Unadjusted winner figures differ by about 2.6 points (std); shrinkage keeps 40%.
    assert winners["rein_index"].std() < 1.5
    one_race = rated.loc[rated.race_id.eq("0000")].sort_values("finish_position")
    assert one_race["rein_index"].is_monotonic_decreasing


def test_features_use_only_earlier_starts():
    rows = _race("A", "2025-01-05", ["1:34.0", "1:35.0"], ["x", "y"])
    rows += _race("B", "2025-02-05", ["1:33.0", "1:34.0"], ["y", "x"])
    rows += _race("C", "2025-03-05", ["1:36.0", "1:33.0"], ["x", "y"])
    data = pd.DataFrame(rows)
    data["rein_index"] = [10.0, 0.0, 30.0, 5.0, -2.0, 99.0]
    out, names = add_index_features(data)
    x = out.loc[out.horse_id.eq("x")].sort_values("race_date")
    assert np.isnan(x["rein_index_prior"].iloc[0])
    assert x["rein_index_prior"].tolist()[1:] == [10.0, 5.0]
    assert x["rein_index_recent5_max"].iloc[2] == 10.0
    assert x["rein_index_prior_count"].tolist() == [0, 1, 2]
    # The current race's own index (-2 for x in C) never appears in its features.
    assert -2.0 not in out.loc[out.race_id.eq("C"), names].to_numpy()
    assert set(names) <= set(out.columns)


def test_cushion_prior_shrinks_sparse_days():
    history = _history()
    measurements = pd.DataFrame({
        "venue": "東京", "date": sorted(history.race_date.unique()),
        "cushion": [9.0 + (i % 3) for i in range(history.race_date.nunique())],
        "turf_moisture_goal": 12.0, "dirt_moisture_goal": np.nan,
    })
    with_prior = build_rein_index(history, measurements=measurements)
    assert with_prior["track_variant"].notna().all()
