"""REIN index: a track-variant adjusted speed figure for JRA flat races.

The index of a completed run is

    raw   = 1000 * (speed / course_par_speed - 1) + WEIGHT_POINTS * (weight - 55)
    index = raw - day_variant(date, venue, surface)

``course_par_speed`` is the median speed of top-3 finishers for the same venue,
surface and distance in the par period only.  The day variant is how much faster
or slower the day's races ran than their class par.  It is shrunk toward a prior
that can be predicted from the official cushion value and moisture content, so
days with few races still receive a sensible correction.

An index describes a race that has finished.  Predictive features built from it
(``add_index_features``) only use a horse's earlier starts, so the current race,
same-day results and later races never enter a prediction.
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

WEIGHT_POINTS = 1.5
VARIANT_SHRINK_RACES = 2.0
MIN_PAR_RUNS = 30
FLAT_SURFACES = ("芝", "ダート")
CLASS_TIER = {
    "新馬": 0, "未勝利": 1, "500万円以下": 2, "1勝クラス": 2,
    "1000万円以下": 3, "2勝クラス": 3, "1600万円以下": 4, "3勝クラス": 4,
    "オープン": 5,
}
INDEX_FEATURES = [
    "rein_index_prior", "rein_index_recent3", "rein_index_recent5_max",
    "rein_index_prior_count", "rein_index_trend", "rein_index_surface_recent3",
    "rein_index_recent5_max_rel", "rein_index_recent3_rel",
]
_TIME = re.compile(r"^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$")


def finish_seconds(values: pd.Series) -> pd.Series:
    """Parse JRA finish times such as ``1:34.5`` or ``58.9`` into seconds."""
    def parse(value: object) -> float:
        if value is None or (isinstance(value, float) and np.isnan(value)):
            return np.nan
        match = _TIME.match(str(value))
        if not match:
            return np.nan
        minutes = float(match.group(1) or 0)
        return minutes * 60 + float(match.group(2))
    return values.map(parse).astype(float)


def _class_tier(race_class: pd.Series) -> pd.Series:
    return race_class.map(CLASS_TIER).fillna(5).astype(float)


def _cushion_prior(day: pd.DataFrame, measurements: pd.DataFrame | None, par_end: pd.Timestamp) -> pd.Series:
    """Predict a day's variant from official cushion/moisture; 0 when unavailable."""
    prior = pd.Series(0.0, index=day.index)
    if measurements is None or measurements.empty:
        return prior
    m = measurements.rename(columns={"venue": "racecourse", "date": "race_date"}).copy()
    m["race_date"] = pd.to_datetime(m["race_date"], errors="coerce")
    keep = ["racecourse", "race_date", "cushion", "turf_moisture_goal", "dirt_moisture_goal"]
    m = m[[c for c in keep if c in m]].drop_duplicates(["racecourse", "race_date"])
    joined = day.merge(m, on=["racecourse", "race_date"], how="left")
    joined.index = day.index
    for surface, columns in (("芝", ["cushion", "turf_moisture_goal"]), ("ダート", ["dirt_moisture_goal"])):
        columns = [c for c in columns if c in joined]
        if not columns:
            continue
        rows = joined["surface"].eq(surface) & joined[columns].notna().all(axis=1)
        fit = rows & joined["race_date"].le(par_end)
        if fit.sum() < 30:
            continue
        x = joined.loc[fit, columns].astype(float)
        mean, std = x.mean(), x.std().replace(0, 1)
        design = np.column_stack([np.ones(fit.sum()), ((x - mean) / std).to_numpy()])
        weights = joined.loc[fit, "races"].to_numpy(float)
        target = joined.loc[fit, "variant_raw"].to_numpy(float)
        ridge = np.diag([0.0] + [5.0] * len(columns))
        wd = design * weights[:, None]
        beta = np.linalg.solve(design.T @ wd + ridge, wd.T @ target)
        apply = ((joined.loc[rows, columns].astype(float) - mean) / std).to_numpy()
        prior.loc[rows] = np.column_stack([np.ones(rows.sum()), apply]) @ beta
    return prior


def build_rein_index(
    data: pd.DataFrame,
    par_end: str = "2024-12-31",
    measurements: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Return ``data`` with ``rein_index`` (NaN where a run cannot be rated)."""
    x = data.copy()
    x["race_date"] = pd.to_datetime(x["race_date"])
    par_end_ts = pd.Timestamp(par_end)
    seconds = finish_seconds(x["finish_time"])
    position = pd.to_numeric(x["finish_position"], errors="coerce")
    distance = pd.to_numeric(x["distance_m"], errors="coerce")
    rated = x["surface"].isin(FLAT_SURFACES) & seconds.gt(0) & position.gt(0) & distance.gt(0)
    speed = (distance / seconds).where(rated)
    top3 = rated & position.le(3)
    in_par = x["race_date"].le(par_end_ts)

    course_key = ["racecourse", "surface", "distance_m"]
    pars = (pd.DataFrame({**{k: x[k] for k in course_key}, "speed": speed})
            .loc[top3 & in_par].groupby(course_key, observed=True)["speed"].agg(["median", "size"]))
    pars = pars.loc[pars["size"].ge(MIN_PAR_RUNS), "median"].rename("par_speed")
    fallback = (pd.DataFrame({"surface": x["surface"], "distance_m": x["distance_m"], "speed": speed})
                .loc[top3 & in_par].groupby(["surface", "distance_m"], observed=True)["speed"]
                .median().rename("par_fallback"))
    par = x[course_key].merge(pars.reset_index(), on=course_key, how="left")["par_speed"]
    par_fb = x[["surface", "distance_m"]].merge(fallback.reset_index(), on=["surface", "distance_m"], how="left")["par_fallback"]
    par_speed = pd.Series(par.to_numpy(), index=x.index).fillna(pd.Series(par_fb.to_numpy(), index=x.index))

    weight = pd.to_numeric(x["weight_carried"], errors="coerce")
    raw = 1000 * (speed / par_speed - 1) + WEIGHT_POINTS * (weight - 55).fillna(0)

    tier = _class_tier(x["race_class"])
    juvenile = pd.to_numeric(x["age"], errors="coerce").le(2)
    class_key = pd.DataFrame({"tier": tier, "surface": x["surface"], "juvenile": juvenile})
    class_par = (class_key.assign(raw=raw).loc[top3 & in_par & raw.notna()]
                 .groupby(["tier", "surface", "juvenile"], observed=True)["raw"].median().rename("class_par"))
    cp = class_key.merge(class_par.reset_index(), on=["tier", "surface", "juvenile"], how="left")["class_par"]
    residual = raw - pd.Series(cp.to_numpy(), index=x.index)

    per_race = (pd.DataFrame({"race_id": x["race_id"], "race_date": x["race_date"],
                              "racecourse": x["racecourse"], "surface": x["surface"], "residual": residual})
                .loc[top3 & residual.notna()]
                .groupby(["race_id", "race_date", "racecourse", "surface"], observed=True)["residual"]
                .median().reset_index())
    day = (per_race.groupby(["race_date", "racecourse", "surface"], observed=True)["residual"]
           .agg(variant_sum="sum", races="size").reset_index())
    day["variant_raw"] = day["variant_sum"] / day["races"]
    day["variant_prior"] = _cushion_prior(day, measurements, par_end_ts)
    day["track_variant"] = ((day["variant_sum"] + VARIANT_SHRINK_RACES * day["variant_prior"])
                            / (day["races"] + VARIANT_SHRINK_RACES))
    merged = x[["race_date", "racecourse", "surface"]].merge(
        day[["race_date", "racecourse", "surface", "track_variant"]],
        on=["race_date", "racecourse", "surface"], how="left")
    x["track_variant"] = merged["track_variant"].to_numpy()
    x["rein_index"] = (raw - x["track_variant"]).where(rated & par_speed.notna())
    return x


def add_index_features(data: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Point-in-time predictive features from each horse's earlier REIN indices."""
    z = data.copy()
    z["race_date"] = pd.to_datetime(z["race_date"])
    order = z.sort_values(["horse_id", "race_date", "race_id"]).index
    s = z.loc[order]
    horse = s["horse_id"]
    previous = s["rein_index"].groupby(horse, observed=True, dropna=False).shift(1)

    def rolling(values: pd.Series, keys, window: int, how: str) -> pd.Series:
        grouped = values.groupby(keys, observed=True, dropna=False)
        rolled = grouped.rolling(window, min_periods=1)
        result = rolled.max() if how == "max" else rolled.mean()
        return result.reset_index(level=list(range(result.index.nlevels - 1)), drop=True)

    out = pd.DataFrame(index=s.index)
    out["rein_index_prior"] = previous
    out["rein_index_recent3"] = rolling(previous, horse, 3, "mean")
    out["rein_index_recent5_max"] = rolling(previous, horse, 5, "max")
    out["rein_index_prior_count"] = previous.notna().groupby(horse, observed=True, dropna=False).cumsum()
    out["rein_index_trend"] = out["rein_index_prior"] - out["rein_index_recent3"]
    surface_keys = [horse, s["surface"]]
    same_surface_prev = s["rein_index"].groupby(surface_keys, observed=True, dropna=False).shift(1)
    out["rein_index_surface_recent3"] = rolling(same_surface_prev, surface_keys, 3, "mean")
    unknown = horse.isna() | horse.astype(str).str.strip().eq("")
    out.loc[unknown, :] = np.nan
    out.loc[unknown, "rein_index_prior_count"] = 0
    for column in out:
        z[column] = out[column].reindex(z.index)
    race = z.groupby("race_id", observed=True)
    z["rein_index_recent5_max_rel"] = z["rein_index_recent5_max"] - race["rein_index_recent5_max"].transform("median")
    z["rein_index_recent3_rel"] = z["rein_index_recent3"] - race["rein_index_recent3"].transform("median")
    return z, list(INDEX_FEATURES)
