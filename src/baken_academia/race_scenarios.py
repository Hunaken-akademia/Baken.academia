"""Race-shape scenarios, same-day track bias with a significance gate, and
scenario-mixture ticket probabilities.

Scenario of a finished race (label only, never a prediction input):
``front`` when its top-3 finishers ran unusually close to the lead at the first
corner, ``closer`` when they came from unusually far back, else ``neutral``.
Cut points are the terciles of the top-3 mean early position in a fixed
reference period.

Same-day bias for a race uses only earlier race numbers at the same venue,
date and surface.  ``bias_shrunk`` is always on; ``bias_gated`` is the same
value only when at least ``GATE_MIN_RACES`` earlier races exist and the mean
deviation is at least ``GATE_Z`` standard errors from zero, otherwise 0, so
the bias is used for prediction only on days where it is clear.

Ticket probabilities mix per-scenario Harville calculations:
P(ticket) = sum_s P(s) * P(ticket | s).  Unlike a single Harville over the
marginal probabilities, this lets runners who suit the same race shape rise
and fall together, which matters most for trio and trifecta.
"""
from __future__ import annotations

import itertools
import json

import numpy as np
import pandas as pd

SCENARIOS = ("front", "neutral", "closer")
BIAS_SHRINK_RACES = 3.0
GATE_MIN_RACES = 3
GATE_Z = 2.0
MIN_SPREAD = 0.08


def first_corner_share(corner_positions: pd.Series, field_size: pd.Series) -> pd.Series:
    def first(value: object) -> float:
        try:
            items = json.loads(value) if isinstance(value, str) else value
            for item in items or []:
                text = str(item).strip()
                if text.isdigit() and int(text) > 0:
                    return float(text)
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
        return np.nan
    position = corner_positions.map(first)
    return (position / field_size.clip(lower=1)).where(position.le(field_size))


def race_number(race_id: pd.Series) -> pd.Series:
    """JRA ids look like ``20260105-中山-11``; NAR-style ids end in the number."""
    text = race_id.astype(str)
    tail = text.str.extract(r"-(\d{1,2})$")[0].fillna(text.str[-2:])
    return pd.to_numeric(tail, errors="coerce")


def race_shape(data: pd.DataFrame) -> pd.DataFrame:
    """One row per race: top-3 mean early share (NaN when fewer than 2 known)."""
    field = data.groupby("race_id", observed=True)["race_id"].transform("size")
    early = first_corner_share(data["corner_positions"], field)
    top3 = pd.to_numeric(data["finish_position"], errors="coerce").between(1, 3)
    frame = pd.DataFrame({"race_id": data["race_id"], "early": early.where(top3)})
    shape = frame.groupby("race_id", observed=True)["early"].agg(["mean", "count"])
    shape.loc[shape["count"] < 2, "mean"] = np.nan
    meta = data.groupby("race_id", observed=True)[["race_date", "racecourse", "surface"]].first()
    return meta.join(shape["mean"].rename("top3_early")).reset_index()


def label_scenarios(shape: pd.DataFrame, reference_end: str) -> tuple[pd.Series, dict]:
    ref = shape.loc[pd.to_datetime(shape["race_date"]).le(pd.Timestamp(reference_end)), "top3_early"].dropna()
    low, high = float(ref.quantile(1 / 3)), float(ref.quantile(2 / 3))
    labels = pd.Series(np.where(shape["top3_early"].le(low), "front",
                                np.where(shape["top3_early"].ge(high), "closer", "neutral")),
                       index=shape.index).where(shape["top3_early"].notna())
    return labels, {"front_max": low, "closer_min": high, "reference_mean": float(ref.mean()),
                    "reference_std": float(ref.std())}


def day_bias(shape: pd.DataFrame, reference_mean: float) -> pd.DataFrame:
    """Point-in-time same-day bias from strictly earlier race numbers.

    Positive values mean earlier races that day favoured closers.
    """
    s = shape.copy()
    s["race_no"] = race_number(s["race_id"])
    s["dev"] = s["top3_early"] - reference_mean
    s = s.sort_values(["race_date", "racecourse", "surface", "race_no"])
    known = s["dev"].notna().astype(float)
    filled = s["dev"].fillna(0.0)
    keys = [s["race_date"], s["racecourse"], s["surface"]]
    s["bias_races"] = known.groupby(keys, observed=True).cumsum() - known
    total = filled.groupby(keys, observed=True).cumsum() - filled
    squares = (filled ** 2).groupby(keys, observed=True).cumsum() - filled ** 2
    n = s["bias_races"]
    mean = (total / n).where(n > 0)
    var = ((squares - n * mean ** 2) / (n - 1)).where(n > 1)
    # Floor the spread so a few identical races cannot claim infinite certainty.
    se = np.sqrt(var.clip(lower=MIN_SPREAD ** 2) / n)
    s["bias_shrunk"] = (total / (n + BIAS_SHRINK_RACES)).fillna(0.0)
    s["bias_z"] = (mean / se).replace([np.inf, -np.inf], np.nan)
    s["bias_gate_on"] = (n.ge(GATE_MIN_RACES) & s["bias_z"].abs().ge(GATE_Z)).astype(float)
    s["bias_gated"] = s["bias_shrunk"] * s["bias_gate_on"]
    return s[["race_id", "bias_races", "bias_shrunk", "bias_z", "bias_gate_on", "bias_gated"]]


def _harville(rows: list[dict], weight: float, out: dict[str, dict[tuple[int, ...], float]]) -> None:
    def add(bet: str, key: tuple[int, ...], p: float) -> None:
        bucket = out[bet]
        bucket[key] = bucket.get(key, 0.0) + weight * p
    for a in rows:
        add("win", (a["horse_number"],), a["first"])
        add("place", (a["horse_number"],), a["first"] + a["second"] + a["third"])
    for a, b in itertools.permutations(rows, 2):
        p = a["first"] * b["second"] / max(1 - a["second"], 1e-12)
        add("exacta", (a["horse_number"], b["horse_number"]), p)
        add("quinella", tuple(sorted((a["horse_number"], b["horse_number"]))), p)
        add("bracket_quinella", tuple(sorted((a["gate"], b["gate"]))), p)
    for a, b, c in itertools.permutations(rows, 3):
        p = (a["first"] * b["second"] / max(1 - a["second"], 1e-12)
             * c["third"] / max(1 - a["third"] - b["third"], 1e-12))
        add("trifecta", (a["horse_number"], b["horse_number"], c["horse_number"]), p)
        add("trio", tuple(sorted((a["horse_number"], b["horse_number"], c["horse_number"]))), p)
        for pair in ((a, b), (a, c), (b, c)):
            add("wide", tuple(sorted((pair[0]["horse_number"], pair[1]["horse_number"]))), p)


def mixture_candidates(
    horses: pd.DataFrame,
    scenario_weights: dict[str, float],
    marginals: dict[str, np.ndarray],
    tilts: dict[str, dict[str, np.ndarray]] | None,
    support: int = 9,
) -> dict[str, pd.DataFrame]:
    """Ticket probabilities from a mixture of per-scenario role probabilities.

    ``marginals[role]`` is the final per-runner role probability (for example
    70% market + 30% REIN).  ``tilts[s][role]`` is the scenario model's
    p(role | s) / p(role) for each runner; each scenario's role vector is
    ``marginal * tilt`` renormalised.  With ``tilts=None`` this reduces to a
    single Harville over the marginals.
    """
    base = horses[["horse_number", "gate"]].astype(int).reset_index(drop=True)
    strength = np.max(np.vstack([marginals[r] for r in ("first", "second", "third")]), axis=0)
    keep = np.argsort(-strength, kind="stable")[:support] if len(base) > support else np.arange(len(base))
    out: dict[str, dict[tuple[int, ...], float]] = {b: {} for b in (
        "win", "place", "exacta", "quinella", "bracket_quinella", "trifecta", "trio", "wide")}
    scenarios = scenario_weights.items() if tilts else [("all", 1.0)]
    for scenario, weight in scenarios:
        roles = {}
        for role in ("first", "second", "third"):
            v = marginals[role] * (tilts[scenario][role] if tilts else 1.0)
            v = v[keep]
            roles[role] = v / v.sum()
        rows = [{"horse_number": int(base.loc[i, "horse_number"]), "gate": int(base.loc[i, "gate"]),
                 "first": roles["first"][j], "second": roles["second"][j], "third": roles["third"][j]}
                for j, i in enumerate(keep)]
        _harville(rows, float(weight), out)
    return {bet: pd.DataFrame({"selection": list(v), "probability": list(v.values())}) for bet, v in out.items()}


def pick_tickets(frames: dict[str, pd.DataFrame], caps: dict, groups: tuple[str, ...]) -> pd.DataFrame:
    """Apply the main/counter/longshot caps in probability order (as research v4)."""
    outputs = []
    for bet, frame in frames.items():
        remaining = frame.sort_values("probability", ascending=False, kind="stable")
        counts = caps[bet].__dict__.values() if hasattr(caps[bet], "__dict__") else caps[bet].values()
        for group, count in zip(groups, counts):
            picked = remaining.head(count).assign(ticket_type=group, bet_type=bet)
            outputs.append(picked)
            remaining = remaining.iloc[len(picked):]
    return pd.concat(outputs, ignore_index=True)
