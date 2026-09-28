import numpy as np
import pandas as pd
from scripts.nar_live_model import normalize_courses, prior_features, inputs_by_mode


def sample():
    return pd.DataFrame([dict(race_id=f"r{i}", race_date=pd.Timestamp(date), horse_id="1", jockey_id="2", trainer_id="3", surface="ダート", racecourse="沢", baba_code="22", gate=1, distance_m=1400, finish_position=finish)
                         for i, (date, finish) in enumerate([("2024-01-01", 1), ("2024-01-01", 3), ("2024-01-02", 2)])])


def test_course_codes_separate_water_and_gold_and_banei():
    df = sample()
    df["baba_code"] = [11, 22, 3]
    fixed = normalize_courses(df)
    assert list(fixed.racecourse) == ["水沢", "金沢", "帯広"]
    assert fixed.surface.iloc[2] == "ばんえい"


def test_history_excludes_the_entire_current_day():
    df = normalize_courses(sample())
    values = prior_features(df)
    np.testing.assert_array_equal(values[0], values[1])
    assert values[0, 1] == 1.5 / 20
    assert values[2, 1] == 2.5 / 22
    assert values[2, 2] == 6.5 / 22
    altered = df.copy()
    altered.loc[2, "finish_position"] = 1
    np.testing.assert_array_equal(values, prior_features(altered))


def test_relative_equal_fields_are_finite():
    modes = inputs_by_mode(np.ones((3, 4)), pd.Series(["r", "r", "r"]))
    assert np.isfinite(modes["hybrid"]).all()
    assert not modes["relative"].any()
