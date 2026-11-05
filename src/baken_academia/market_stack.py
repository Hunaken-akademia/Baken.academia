"""Second-stage conditional logit that combines market and REIN role probabilities.

For one finishing role (1st, 2nd or 3rd) each runner gets a linear score from
features such as log market probability and log REIN role probability, plus
their interactions with race context.  Probabilities are the softmax of the
scores within a race, and the coefficients are fitted by penalised maximum
likelihood.  This replaces a fixed blend such as 70% market + 30% REIN with
weights that can depend on field size, surface, class and how split the market
is, and it also learns how sharp each role's distribution should be.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.optimize import minimize

ROLES = ("first", "second", "third")
EPS = 1e-6


def normalize_within(values: pd.Series, race_id: pd.Series) -> pd.Series:
    v = pd.to_numeric(values, errors="coerce").fillna(0).clip(lower=EPS)
    return v / v.groupby(race_id, observed=True).transform("sum")


def market_probability(popularity: pd.Series, race_id: pd.Series) -> pd.Series:
    """Reciprocal popularity, normalised per race (same rule as the web tickets)."""
    pop = pd.to_numeric(popularity, errors="coerce")
    fallback = pop.groupby(race_id, observed=True).transform("max").fillna(0)
    size = race_id.groupby(race_id, observed=True).transform("size")
    fallback = np.maximum(fallback, size) + 1
    return normalize_within(1 / pop.fillna(fallback).clip(lower=1), race_id)


def stack_features(frame: pd.DataFrame, role: str, context: bool) -> pd.DataFrame:
    """Build the per-runner design for one role.

    ``frame`` needs race_id, market_probability, field_size, surface, class_tier
    and ``<role>_probability`` columns for every role.
    """
    race = frame["race_id"]
    lm = np.log(frame["market_probability"].clip(lower=EPS))
    lr = np.log(normalize_within(frame[f"{role}_probability"], race))
    f = pd.DataFrame({"log_market": lm, "log_role": lr, "log_market_sq": lm ** 2}, index=frame.index)
    for other in ROLES:
        if other != role:
            f[f"log_{other}"] = np.log(normalize_within(frame[f"{other}_probability"], race))
    if context:
        size = pd.to_numeric(frame["field_size"], errors="coerce")
        entropy = -(frame["market_probability"] * lm).groupby(race, observed=True).transform("sum")
        effective = np.exp(entropy) / size.clip(lower=1)
        small = size.le(10).astype(float)
        large = size.ge(15).astype(float)
        turf = frame["surface"].eq("芝").astype(float)
        upper = pd.to_numeric(frame["class_tier"], errors="coerce").ge(4).astype(float)
        maiden = pd.to_numeric(frame["class_tier"], errors="coerce").le(1).astype(float)
        split = effective - 0.6
        for name, term in (("small", small), ("large", large), ("turf", turf),
                           ("upper", upper), ("maiden", maiden), ("split", split)):
            f[f"log_market_x_{name}"] = lm * term
            f[f"log_role_x_{name}"] = lr * term
    return f.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def _segments(race_id: pd.Series) -> np.ndarray:
    codes = pd.factorize(race_id, sort=False)[0]
    if len(codes) and np.any(np.diff(codes) < 0):
        raise ValueError("Rows must be contiguous by race")
    return np.flatnonzero(np.r_[True, np.diff(codes) != 0])


def _softmax(scores: np.ndarray, starts: np.ndarray) -> np.ndarray:
    peak = np.maximum.reduceat(scores, starts)
    lengths = np.diff(np.r_[starts, len(scores)])
    e = np.exp(scores - np.repeat(peak, lengths))
    return e / np.repeat(np.add.reduceat(e, starts), lengths)


@dataclass
class ConditionalLogit:
    l2: float = 1.0
    columns: list[str] = field(default_factory=list)
    mean: np.ndarray | None = None
    scale: np.ndarray | None = None
    coef: np.ndarray | None = None

    def _design(self, features: pd.DataFrame) -> np.ndarray:
        return (features[self.columns].to_numpy(float) - self.mean) / self.scale

    def fit(self, features: pd.DataFrame, race_id: pd.Series, target: pd.Series) -> "ConditionalLogit":
        self.columns = list(features.columns)
        values = features.to_numpy(float)
        self.mean = values.mean(axis=0)
        self.scale = values.std(axis=0)
        self.scale[self.scale == 0] = 1.0
        x = self._design(features)
        y = target.to_numpy(float)
        starts = _segments(race_id)
        has_winner = np.add.reduceat(y, starts) > 0
        lengths = np.diff(np.r_[starts, len(y)])
        keep = np.repeat(has_winner, lengths)
        x, y = x[keep], y[keep]
        starts = _segments(race_id[keep])
        races = len(starts)
        start = np.zeros(x.shape[1])
        for name in ("log_market", "log_role"):
            if name in self.columns:
                start[self.columns.index(name)] = 0.5

        def loss(beta: np.ndarray) -> tuple[float, np.ndarray]:
            p = _softmax(x @ beta, starts)
            nll = -np.sum(y * np.log(np.clip(p, 1e-15, None))) / races
            grad = x.T @ (p - y) / races
            return nll + 0.5 * self.l2 * beta @ beta / races, grad + self.l2 * beta / races

        result = minimize(loss, start, jac=True, method="L-BFGS-B", options={"maxiter": 500})
        self.coef = result.x
        return self

    def predict(self, features: pd.DataFrame, race_id: pd.Series) -> np.ndarray:
        return _softmax(self._design(features) @ self.coef, _segments(race_id))

    def coefficients(self) -> dict[str, float]:
        return {name: float(value) for name, value in zip(self.columns, self.coef / self.scale)}


def role_log_loss(probability: pd.Series, target: pd.Series, race_id: pd.Series) -> float:
    """Mean negative log probability of the actual role finisher, per race."""
    hit = target.astype(bool)
    eligible = hit.groupby(race_id, observed=True).transform("sum").eq(1)
    chosen = probability.loc[hit & eligible].clip(lower=1e-15)
    return float(-np.log(chosen).mean()) if len(chosen) else float("nan")


def day_bootstrap(diff: pd.Series, dates: pd.Series, draws: int = 2000, seed: int = 20261105) -> dict[str, float]:
    """95% interval for the mean of a per-race difference, resampling whole days."""
    frame = pd.DataFrame({"diff": diff.to_numpy(float), "date": dates.to_numpy()}).dropna()
    if frame.empty:
        return {"mean": float("nan"), "low": float("nan"), "high": float("nan"), "races": 0}
    daily = frame.groupby("date")["diff"].agg(["sum", "size"])
    rng = np.random.default_rng(seed)
    pick = rng.integers(0, len(daily), size=(draws, len(daily)))
    sums, sizes = daily["sum"].to_numpy()[pick].sum(axis=1), daily["size"].to_numpy()[pick].sum(axis=1)
    means = sums / sizes
    return {"mean": float(frame["diff"].mean()), "low": float(np.quantile(means, .025)),
            "high": float(np.quantile(means, .975)), "races": int(len(frame))}
