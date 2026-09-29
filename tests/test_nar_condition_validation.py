import numpy as np
import pandas as pd

from scripts.nar_condition_validation import condition_keys, conditioned_predict, interval, signal_audit, top5_hits


def test_condition_boundaries_and_unknown_going():
    frame = pd.DataFrame({"racecourse": ["水沢"]*4, "surface": ["ダート"]*4,
                          "distance_m": [1300, 1400, 1800, 1900], "going": ["良", "重", None, "不良"]})
    assert condition_keys(frame, "courseDistance").tolist() == ["水沢|ダート|short", "水沢|ダート|mile", "水沢|ダート|mile", "水沢|ダート|long"]
    assert condition_keys(frame, "courseGoing").iloc[2] == "水沢|ダート|不明"


def test_missing_condition_uses_global_without_changing_order():
    frame = pd.DataFrame({"racecourse": ["水沢", "高知"], "surface": ["ダート"]*2})
    base = {"coef": np.array([2.]), "intercept": 1.}
    local = {"水沢|ダート": {"coef": np.array([3.]), "intercept": 0.}}
    assert conditioned_predict(frame, np.array([[1.], [2.]]), base, local, "course").tolist() == [3., 5.]


def test_bootstrap_requires_dates_not_horse_count():
    assert interval(np.ones(1000), ["2026-01-01"]*1000) is None
    assert interval(np.ones(60), pd.date_range("2026-01-01", periods=60)) == [1., 1.]


def test_exact_target_ties_excluded():
    frame = pd.DataFrame({"race_id": ["a", "a", "b", "b"], "finish_position": [1, 1, 1, 2]})
    assert top5_hits(frame, np.array([4, 3, 2, 1]), 1).index.tolist() == [2]


def test_popularity_matched_signal_does_not_confuse_pop1_with_pop3():
    frame = pd.DataFrame({"popularity": [1, 1, 3, 3], "racecourse": ["水沢"]*4,
                          "fieldSize": [10]*4, "finish_position": [1, 2, 5, 6], "race_date": ["2026-01-01"]*4})
    result = signal_audit(frame, frame.popularity.eq(3), "danger")
    assert result["difference"] == 0
    assert result["samples"] == 2
