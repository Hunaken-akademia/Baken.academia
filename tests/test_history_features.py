import pandas as pd

from baken_academia.history_features import add_point_in_time_features


def _row(race_id, date, horse, jockey, trainer, finish, surface="芝"):
    return {
        "race_id": race_id,
        "race_date": date,
        "horse_id": horse,
        "jockey_id": jockey,
        "trainer_id": trainer,
        "finish_position": finish,
        "racecourse": "東京",
        "surface": surface,
        "distance_m": 1600,
        "horse_number": 1,
        "gate": 1,
        "weight_carried": 55.0,
        "horse_weight": 480.0,
    }


def test_history_uses_only_strictly_prior_days():
    frame = pd.DataFrame(
        [
            _row("r1", "2026-01-01", "h1", "j1", "t1", 1),
            _row("r2", "2026-01-02", "h1", "j1", "t1", 4),
            _row("r3", "2026-01-02", "h2", "j1", "t1", 1),
            _row("r4", "2026-01-03", "h1", "j1", "t1", 2),
        ]
    )
    result = add_point_in_time_features(frame).set_index("race_id")

    assert result.loc["r1", "horse_starts"] == 0
    assert result.loc["r2", "horse_starts"] == 1
    assert result.loc["r4", "horse_starts"] == 2
    # Both races on Jan 2 see only Jan 1 for jockey history.
    assert result.loc["r2", "jockey_starts"] == 1
    assert result.loc["r3", "jockey_starts"] == 1
    assert result.loc["r4", "jockey_starts"] == 3


def test_current_result_does_not_change_its_own_features():
    frame = pd.DataFrame(
        [
            _row("r1", "2026-01-01", "h1", "j1", "t1", 1),
            _row("r2", "2026-01-02", "h1", "j1", "t1", 5),
        ]
    )
    before = add_point_in_time_features(frame).set_index("race_id")
    changed = frame.copy()
    changed.loc[changed["race_id"] == "r2", "finish_position"] = 2
    after = add_point_in_time_features(changed).set_index("race_id")

    columns = [c for c in before.columns if c.startswith("horse_")]
    pd.testing.assert_series_equal(before.loc["r2", columns], after.loc["r2", columns])
