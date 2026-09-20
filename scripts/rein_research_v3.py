"""REIN v3 offline research: closing kick, class, distance and pace matchup.

This script never changes the deployed REIN scorer. Model and blend selection use
2023 only; 2024 is printed afterwards as a chronological audit.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rein_research import metrics, prepare

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from baken_academia.features import build_feature_frame


OUT = Path("reports/rein-research-v3")
OUT.mkdir(parents=True, exist_ok=True)

CLASS_TIER = {
    "新馬": 0,
    "未勝利": 1,
    "500万円以下": 2,
    "1勝クラス": 2,
    "1000万円以下": 3,
    "2勝クラス": 3,
    "1600万円以下": 4,
    "3勝クラス": 4,
    "オープン": 5,
}


def add_v3_features(x: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Create target-day-safe additions from completed races only."""
    z = x.sort_values(["horse_id", "race_date", "race_id"]).copy()
    horse = z.groupby("horse_id", observed=True, dropna=False)
    field = z.groupby("race_id", observed=True)["horse_id"].transform("size")

    z["class_tier"] = z["race_class"].map(CLASS_TIER).astype(float)
    z["prior_class_tier"] = horse["class_tier"].shift(1)
    z["class_change"] = z["class_tier"] - z["prior_class_tier"]
    z["class_rise"] = z["class_change"].clip(lower=0)
    z["class_drop"] = (-z["class_change"]).clip(lower=0)
    z["recent5_max_class"] = (
        z["prior_class_tier"]
        .groupby(z["horse_id"], observed=True)
        .rolling(5, min_periods=1)
        .max()
        .reset_index(level=0, drop=True)
    )
    z["class_vs_recent_max"] = z["class_tier"] - z["recent5_max_class"]

    z["prior_distance_m"] = horse["distance_m"].shift(1)
    z["distance_abs_change"] = (z["distance_m"] - z["prior_distance_m"]).abs()
    z["stretching_out"] = (z["distance_m"] - z["prior_distance_m"]).clip(lower=0)
    z["shortening"] = (z["prior_distance_m"] - z["distance_m"]).clip(lower=0)
    z["recent3_distance_m"] = (
        z["prior_distance_m"]
        .groupby(z["horse_id"], observed=True)
        .rolling(3, min_periods=1)
        .mean()
        .reset_index(level=0, drop=True)
    )
    z["distance_vs_recent3"] = z["distance_m"] - z["recent3_distance_m"]

    # avg_1f is final 3F on flat races, but average 1F on obstacle races.
    closing = pd.to_numeric(z["avg_1f"], errors="coerce").where(z["surface"].isin(["芝", "ダート"]))
    race_median = closing.groupby(z["race_id"], observed=True).transform("median")
    race_std = closing.groupby(z["race_id"], observed=True).transform("std").replace(0, np.nan)
    closing_relative = closing - race_median
    closing_z = closing_relative / race_std
    for name, values in {"closing3f_relative": closing_relative, "closing3f_z": closing_z}.items():
        previous = values.groupby(z["horse_id"], observed=True).shift(1)
        z["prior_" + name] = previous
        for window in (3, 5):
            z[f"recent{window}_{name}"] = (
                previous.groupby(z["horse_id"], observed=True)
                .rolling(window, min_periods=1)
                .mean()
                .reset_index(level=0, drop=True)
            )

    # Race shape derived only from each entrant's prior running position.
    z["front_style"] = z["prior_early_pct"].le(0.25).astype(float)
    z["stalk_style"] = z["prior_early_pct"].between(0.25, 0.50, inclusive="right").astype(float)
    z["closer_style"] = z["prior_early_pct"].gt(0.50).astype(float)
    race = z.groupby("race_id", observed=True)
    z["front_pressure_count"] = race["front_style"].transform("sum")
    z["front_pressure_share"] = z["front_pressure_count"] / field
    z["known_style_share"] = race["prior_early_pct"].transform("count") / field
    z["front_under_pressure"] = z["front_style"] * z["front_pressure_share"]
    z["closer_pressure_help"] = z["closer_style"] * z["front_pressure_share"]
    z["relative_late"] = z["prior_late_pct"] - race["prior_late_pct"].transform("mean")
    z["closing_pressure_fit"] = -z["recent3_closing3f_z"] * z["front_pressure_share"]

    # A prior result strength signal: good normalized result achieved at class.
    prior_result_strength = (
        (1 - pd.to_numeric(z["finish_position"], errors="coerce") / field)
        + z["class_tier"].fillna(0) * 0.08
    ).groupby(z["horse_id"], observed=True).shift(1)
    z["recent3_result_strength"] = (
        prior_result_strength.groupby(z["horse_id"], observed=True)
        .rolling(3, min_periods=1)
        .mean()
        .reset_index(level=0, drop=True)
    )

    added = [
        "class_tier", "prior_class_tier", "class_change", "class_rise", "class_drop",
        "recent5_max_class", "class_vs_recent_max", "prior_distance_m",
        "distance_abs_change", "stretching_out", "shortening", "recent3_distance_m",
        "distance_vs_recent3", "prior_closing3f_relative", "recent3_closing3f_relative",
        "recent5_closing3f_relative", "prior_closing3f_z", "recent3_closing3f_z",
        "recent5_closing3f_z", "front_style", "stalk_style", "closer_style",
        "front_pressure_count", "front_pressure_share", "known_style_share",
        "front_under_pressure", "closer_pressure_help", "relative_late",
        "closing_pressure_fit", "recent3_result_strength",
    ]
    return z.sort_index(), added


def race_probability(x: pd.DataFrame, values: np.ndarray) -> np.ndarray:
    """Normalize a positive runner score within each race."""
    s = pd.Series(np.clip(values, 1e-9, None), index=x.index)
    return (s / s.groupby(x["race_id"], observed=True).transform("sum")).to_numpy()


def objective(m: dict) -> float:
    """Balance the user's rank-1 and top-three-set goals."""
    first = m["by_rank"][0]
    return (
        first["win"] + first["top3"] + m["winner_in_top3"]
        + m["two_placed"] + 0.5 * m["three_placed"]
    )


def main() -> None:
    raw = pd.read_parquet("data/raw/history.parquet")
    print("preparing", len(raw), flush=True)
    x, added = add_v3_features(prepare(raw))
    base, _, _ = build_feature_frame(x)
    inherited = [
        c for c in x
        if c.startswith(("prior_", "recent3_")) or "_recent90_" in c
    ] + ["expected_front_count", "relative_early"]
    features = list(dict.fromkeys(inherited + added))
    market = pd.DataFrame(index=x.index)
    market["popularity"] = pd.to_numeric(x["popularity"], errors="coerce")
    market["popularity_pct"] = market["popularity"] / x["field_size"]
    # Keep the REIN model independent from current popularity so the later
    # blend can measure genuinely complementary form/style information.
    frame = pd.concat([base, x[features]], axis=1)

    train = x["race_date"].lt("2023-01-01")
    validation = x["race_date"].between("2023-01-01", "2023-12-31")
    audit = x["race_date"].between("2024-01-01", "2024-12-31")
    later = x["race_date"].ge("2025-01-01")
    flat = x["surface"].isin(["芝", "ダート"])

    predictions: dict[str, np.ndarray] = {
        "popularity": -market["popularity"].fillna(999).to_numpy()
    }
    models = {}
    for target in ("win", "place"):
        y = x["finish_position"].eq(1) if target == "win" else x["finish_position"].between(1, 3)
        name = "v3_" + target
        print("training", name, flush=True)
        model = lgb.LGBMClassifier(
            n_estimators=900, learning_rate=0.025, num_leaves=15,
            min_child_samples=250, feature_fraction=0.8, bagging_fraction=0.9,
            bagging_freq=1, reg_lambda=8, n_jobs=4, verbosity=-1, random_state=789,
        )
        model.fit(
            frame.loc[train & flat], y.loc[train & flat],
            eval_set=[(frame.loc[validation & flat], y.loc[validation & flat])],
            callbacks=[lgb.early_stopping(60, verbose=False)],
        )
        predictions[name] = model.predict_proba(frame)[:, 1]
        models[name] = model

    # Coarse, predeclared blends are chosen on 2023 only. Popularity remains the
    # anchor; a candidate must beat it on the balanced objective to move away.
    # Reciprocal rank is a rough market probability proxy. Unlike blending raw
    # ordinal ranks, this allows a modest model weight to alter close decisions.
    pop_probability = race_probability(
        x, 1 / market["popularity"].fillna(x["field_size"] + 1).to_numpy()
    )
    selected = {}
    blend_grid = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50]
    for name in ("v3_win", "v3_place"):
        model_probability = race_probability(x, predictions[name])
        trials = []
        for weight in blend_grid:
            blend = (1 - weight) * pop_probability + weight * model_probability
            m, _ = metrics(x.loc[validation & flat], blend[validation & flat])
            trials.append({"model_weight": weight, "objective": objective(m), "metrics": m})
        best = max(trials, key=lambda r: (r["objective"], -r["model_weight"]))
        selected[name] = {"weight": best["model_weight"], "validation_trials": trials}
        predictions["blend_" + name] = (
            (1 - best["model_weight"]) * pop_probability
            + best["model_weight"] * model_probability
        )

    report = {
        "scope": (
            "Offline research only. Selection and blend weights use 2023; "
            "2024 is a chronological audit; 2025-2026 is retrospective."
        ),
        "data": {"rows": len(x), "races": int(x["race_id"].nunique())},
        "notes": [
            "avg_1f is treated as final 3F only for turf/dirt; obstacle is excluded from v3 fitting.",
            "lap_times is empty in the archive, so pace matchup uses prior corner position.",
            "popularity is closing/result-page popularity and is not a morning-time feature.",
        ],
        "features": added,
        "models": {name: {"iterations": model.best_iteration_} for name, model in models.items()},
        "selection": selected,
        "periods": {},
    }
    periods = [
        ("validation_2023_flat", validation & flat),
        ("audit_2024_flat", audit & flat),
        ("retrospective_2025_2026_flat", later & flat),
        ("audit_2024_all", audit),
    ]
    for period, mask in periods:
        report["periods"][period] = {}
        for name, pred in predictions.items():
            m, _ = metrics(x.loc[mask], pred[mask])
            report["periods"][period][name] = m

    gains = {}
    for period in ("audit_2024_flat", "retrospective_2025_2026_flat"):
        base_m = report["periods"][period]["popularity"]
        gains[period] = {}
        for name in ("blend_v3_win", "blend_v3_place"):
            m = report["periods"][period][name]
            gains[period][name] = {
                "rank1_win_pp": 100 * (m["by_rank"][0]["win"] - base_m["by_rank"][0]["win"]),
                "rank1_top3_pp": 100 * (m["by_rank"][0]["top3"] - base_m["by_rank"][0]["top3"]),
                "winner_in_top3_pp": 100 * (m["winner_in_top3"] - base_m["winner_in_top3"]),
                "two_placed_pp": 100 * (m["two_placed"] - base_m["two_placed"]),
                "three_placed_pp": 100 * (m["three_placed"] - base_m["three_placed"]),
            }
    report["gains_vs_popularity"] = gains
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"selection": selected, "gains": gains}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
