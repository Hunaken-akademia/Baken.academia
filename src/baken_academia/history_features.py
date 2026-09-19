from __future__ import annotations

import numpy as np
import pandas as pd


def _prior_daily_rates(
    df: pd.DataFrame,
    keys: list[str],
    prefix: str,
    *,
    smoothing: float = 20.0,
) -> pd.DataFrame:
    """Build entity statistics using completed days strictly before each race day."""

    source = df[keys + ["race_date", "finish_position"]].copy()
    source["is_win"] = (source["finish_position"] == 1).astype(float)
    source["is_top3"] = source["finish_position"].between(1, 3).astype(float)
    source["valid_finish"] = source["finish_position"].notna().astype(float)
    source["finish_sum"] = source["finish_position"].fillna(0.0)

    daily = (
        source.groupby(keys + ["race_date"], observed=True, dropna=False)
        .agg(
            starts=("valid_finish", "sum"),
            wins=("is_win", "sum"),
            top3=("is_top3", "sum"),
            finish_sum=("finish_sum", "sum"),
        )
        .reset_index()
        .sort_values(keys + ["race_date"])
    )
    grouped = daily.groupby(keys, observed=True, dropna=False)
    for metric in ("starts", "wins", "top3", "finish_sum"):
        daily[f"prior_{metric}"] = grouped[metric].cumsum() - daily[metric]

    prior_starts = daily["prior_starts"]
    # A neutral JRA prior. Smoothing prevents one early win from dominating.
    daily[f"{prefix}_starts"] = prior_starts
    daily[f"{prefix}_win_rate"] = (
        daily["prior_wins"] + smoothing * 0.075
    ) / (prior_starts + smoothing)
    daily[f"{prefix}_top3_rate"] = (
        daily["prior_top3"] + smoothing * 0.225
    ) / (prior_starts + smoothing)
    daily[f"{prefix}_avg_finish"] = np.where(
        prior_starts > 0,
        daily["prior_finish_sum"] / prior_starts,
        np.nan,
    )
    columns = keys + ["race_date"] + [
        f"{prefix}_starts",
        f"{prefix}_win_rate",
        f"{prefix}_top3_rate",
        f"{prefix}_avg_finish",
    ]
    return daily[columns]


def add_point_in_time_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add only features available before a race starts.

    Entity rates use previous *days*, not merely previous rows. This avoids
    leaking an early race result into a later race when producing morning
    predictions for the whole card.
    """

    enriched = df.copy()
    enriched["race_date"] = pd.to_datetime(enriched["race_date"], errors="raise")

    race_group = enriched.groupby("race_id", observed=True)
    field_size = race_group["horse_id"].transform("size").astype(float)
    enriched["field_size"] = field_size
    enriched["horse_number_pct"] = enriched["horse_number"] / field_size
    enriched["gate_pct"] = enriched["gate"] / race_group["gate"].transform("max")
    enriched["weight_carried_vs_field"] = (
        enriched["weight_carried"]
        - race_group["weight_carried"].transform("mean")
    )
    enriched["horse_weight_vs_field"] = (
        enriched["horse_weight"] - race_group["horse_weight"].transform("mean")
    )
    enriched["distance_bucket"] = (enriched["distance_m"] // 200).astype("Int64")

    specs = [
        (["horse_id"], "horse"),
        (["jockey_id"], "jockey"),
        (["trainer_id"], "trainer"),
        (["horse_id", "surface"], "horse_surface"),
        (["horse_id", "distance_bucket"], "horse_distance"),
        (["horse_id", "racecourse"], "horse_course"),
    ]
    for keys, prefix in specs:
        stats = _prior_daily_rates(enriched, keys, prefix)
        enriched = enriched.merge(
            stats,
            how="left",
            on=keys + ["race_date"],
            validate="many_to_one",
        )

    ordered = enriched.sort_values(["horse_id", "race_date", "race_id"])
    horse_group = ordered.groupby("horse_id", observed=True, dropna=False)
    previous_date = horse_group["race_date"].shift(1)
    ordered["days_since_last_start"] = (
        ordered["race_date"] - previous_date
    ).dt.days
    ordered["distance_change_m"] = (
        ordered["distance_m"] - horse_group["distance_m"].shift(1)
    )
    ordered["same_surface_as_last"] = (
        ordered["surface"] == horse_group["surface"].shift(1)
    ).astype(float)
    ordered["same_course_as_last"] = (
        ordered["racecourse"] == horse_group["racecourse"].shift(1)
    ).astype(float)

    shifted_finish = horse_group["finish_position"].shift(1)
    ordered["horse_recent5_avg_finish"] = (
        shifted_finish.groupby(ordered["horse_id"], observed=True)
        .rolling(5, min_periods=1)
        .mean()
        .reset_index(level=0, drop=True)
    )
    shifted_win = shifted_finish.eq(1).where(shifted_finish.notna()).astype(float)
    shifted_top3 = shifted_finish.between(1, 3).where(shifted_finish.notna()).astype(float)
    ordered["horse_recent5_win_rate"] = (
        shifted_win.groupby(ordered["horse_id"], observed=True)
        .rolling(5, min_periods=1)
        .mean()
        .reset_index(level=0, drop=True)
    )
    ordered["horse_recent5_top3_rate"] = (
        shifted_top3.groupby(ordered["horse_id"], observed=True)
        .rolling(5, min_periods=1)
        .mean()
        .reset_index(level=0, drop=True)
    )

    return ordered.sort_index()
