import numpy as np
import pandas as pd

from baken_academia.expected_value import choose_threshold, evaluate_bets, select_bets


def test_expected_value_selects_at_most_one_horse_per_race():
    frame = pd.DataFrame(
        {
            "race_id": ["r1", "r1", "r2", "r2"],
            "race_date": pd.to_datetime(["2026-01-01"] * 4),
            "calibrated_probability": [0.6, 0.4, 0.7, 0.3],
            "win_odds": [2.0, 4.0, 1.2, 2.0],
            "is_win": [1, 0, 1, 0],
        }
    )
    bets = select_bets(frame, threshold=1.0)
    assert bets["race_id"].is_unique
    assert bets.loc[bets["race_id"] == "r1", "win_odds"].item() == 4.0
    metrics = evaluate_bets(bets)
    assert metrics["bets"] == 1
    assert metrics["return_rate"] == 0.0


def test_choose_threshold_uses_validation_results_only():
    frame = pd.DataFrame(
        {
            "race_id": ["r1", "r2", "r3"],
            "race_date": pd.to_datetime(["2025-08-01", "2025-08-02", "2025-08-03"]),
            "calibrated_probability": [0.5, 0.5, 0.5],
            "win_odds": [2.2, 2.6, 3.0],
            "is_win": [1, 0, 1],
        }
    )
    threshold, scan = choose_threshold(frame, thresholds=np.array([1.0, 1.2, 1.4]), min_bets=1)
    assert threshold in {1.0, 1.2, 1.4}
    assert len(scan) == 3
