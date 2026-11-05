import numpy as np
import pandas as pd

from baken_academia.market_stack import (
    ConditionalLogit, day_bootstrap, market_probability, role_log_loss, stack_features,
)


def _frame(races=400, size=8, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for r in range(races):
        strength = rng.normal(size=size)
        market_noise = strength + rng.normal(scale=1.0, size=size)
        role_noise = strength + rng.normal(scale=1.0, size=size)
        popularity = (-market_noise).argsort().argsort() + 1
        p = np.exp(strength * 1.5) / np.exp(strength * 1.5).sum()
        winner = rng.choice(size, p=p)
        for i in range(size):
            rows.append({"race_id": f"r{r}", "popularity": popularity[i], "field_size": size,
                         "surface": "芝" if r % 2 else "ダート", "class_tier": r % 6,
                         "first_probability": np.exp(role_noise[i]), "second_probability": 1.0,
                         "third_probability": 1.0, "won": int(i == winner), "race_date": f"2025-01-{1 + r % 28:02d}"})
    frame = pd.DataFrame(rows)
    frame["market_probability"] = market_probability(frame.popularity, frame.race_id)
    return frame


def test_market_probability_sums_to_one_and_favours_favourite():
    frame = _frame(races=3)
    sums = frame.groupby("race_id").market_probability.sum()
    assert np.allclose(sums, 1)
    first = frame.loc[frame.race_id.eq("r0")].sort_values("popularity")
    assert first.market_probability.is_monotonic_decreasing


def test_stack_beats_market_alone_when_role_model_has_signal():
    train, test = _frame(seed=1), _frame(seed=2)
    model = ConditionalLogit(l2=1.0).fit(stack_features(train, "first", context=False), train.race_id, train.won)
    stacked = pd.Series(model.predict(stack_features(test, "first", context=False), test.race_id), index=test.index)
    assert np.allclose(stacked.groupby(test.race_id).sum(), 1)
    assert role_log_loss(stacked, test.won, test.race_id) < role_log_loss(test.market_probability, test.won, test.race_id)
    coefs = model.coefficients()
    assert coefs["log_role"] > 0 and coefs["log_market"] > 0


def test_context_features_are_finite():
    frame = _frame(races=20)
    features = stack_features(frame, "first", context=True)
    assert np.isfinite(features.to_numpy()).all()
    assert "log_role_x_small" in features


def test_day_bootstrap_interval_contains_mean():
    diff = pd.Series([1, 0, 1, 1, 0, 1] * 20, dtype=float)
    dates = pd.Series([f"d{i // 6}" for i in range(len(diff))])
    ci = day_bootstrap(diff, dates, draws=500)
    assert ci["low"] <= ci["mean"] <= ci["high"] and ci["races"] == 120
