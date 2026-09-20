from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd


CLASS_TIER = {
    "新馬": 0, "未勝利": 1, "500万円以下": 2, "1勝クラス": 2,
    "1000万円以下": 3, "2勝クラス": 3, "1600万円以下": 4,
    "3勝クラス": 4, "オープン": 5,
}
CATEGORICAL = {"racecourse", "surface", "sex", "going", "race_class", "jockey_id", "trainer_id"}
SIGNALS = (
    "speed", "speed_relative", "early_pct", "late_pct", "position_gain",
    "finish_pct", "race_first3_laps", "past_popularity", "won", "placed",
)


def _corners(value: Any) -> list[float]:
    try:
        raw = json.loads(value) if isinstance(value, str) else value
        return [float(item) for item in raw if str(item).isdigit()]
    except (TypeError, ValueError, json.JSONDecodeError):
        return []


def _first_laps(value: Any) -> float:
    try:
        raw = json.loads(value) if isinstance(value, str) else value
        return float(sum(raw[:3])) if len(raw) >= 3 else math.nan
    except (TypeError, ValueError, json.JSONDecodeError):
        return math.nan


def _safe_mean(values: pd.Series) -> float:
    value = pd.to_numeric(values, errors="coerce").mean()
    return float(value) if pd.notna(value) else math.nan


def prepare_inference_history(raw: pd.DataFrame) -> pd.DataFrame:
    x = raw.copy()
    x["race_date"] = pd.to_datetime(x["race_date"], errors="raise")
    x = x.loc[~x["finish_status"].astype(str).str.contains("取消|除外")].copy()
    x = x.sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    x["horse_id"] = x["horse_id"].astype(str).str.lstrip("0").replace("", "0")
    x["jockey_id"] = x["jockey_id"].astype(str).str.lstrip("0").replace("", "0")
    x["trainer_id"] = x["trainer_id"].astype(str).str.lstrip("0").replace("", "0")
    field = x.groupby("race_id", observed=True)["horse_id"].transform("size").astype(float)
    x["historical_field_size"] = field
    seconds = x["finish_time"].astype(str).str.extract(r"^(\d+):(\d+(?:\.\d+)?)$").astype(float)
    speed = pd.to_numeric(x["distance_m"], errors="coerce") / (seconds[0] * 60 + seconds[1])
    corners = x["corner_positions"].map(_corners)
    early = corners.map(lambda values: values[0] if values else math.nan) / field
    late = corners.map(lambda values: values[-1] if values else math.nan) / field
    finish = pd.to_numeric(x["finish_position"], errors="coerce")
    x["speed"] = speed
    x["speed_relative"] = speed - speed.groupby(x["race_id"], observed=True).transform("median")
    x["early_pct"] = early
    x["late_pct"] = late
    x["position_gain"] = late - finish / field
    x["finish_pct"] = finish / field
    x["race_first3_laps"] = x["lap_times"].map(_first_laps)
    x["past_popularity"] = pd.to_numeric(x["popularity"], errors="coerce")
    x["won"] = finish.eq(1).astype(float)
    x["placed"] = finish.between(1, 3).astype(float)
    closing = pd.to_numeric(x["avg_1f"], errors="coerce").where(x["surface"].isin(["芝", "ダート"]))
    race_median = closing.groupby(x["race_id"], observed=True).transform("median")
    race_std = closing.groupby(x["race_id"], observed=True).transform("std").replace(0, np.nan)
    x["closing3f_relative"] = closing - race_median
    x["closing3f_z"] = x["closing3f_relative"] / race_std
    x["class_tier_result"] = x["race_class"].map(CLASS_TIER).astype(float)
    x["result_strength"] = (1 - finish / field) + x["class_tier_result"].fillna(0) * .08
    x["distance_bucket"] = (pd.to_numeric(x["distance_m"], errors="coerce") // 200).astype("Int64")
    return x


def _rate(frame: pd.DataFrame) -> tuple[float, float, float, float]:
    finish = pd.to_numeric(frame["finish_position"], errors="coerce").dropna()
    starts = float(len(finish))
    return (
        starts,
        float((finish.eq(1).sum() + 1.5) / (starts + 20)),
        float((finish.between(1, 3).sum() + 4.5) / (starts + 20)),
        float(finish.mean()) if starts else math.nan,
    )


def _put_rate(row: dict[str, Any], prefix: str, frame: pd.DataFrame) -> None:
    starts, win, top3, avg = _rate(frame)
    row[f"{prefix}_starts"] = starts
    row[f"{prefix}_win_rate"] = win
    row[f"{prefix}_top3_rate"] = top3
    row[f"{prefix}_avg_finish"] = avg


@dataclass
class ReinRuntime:
    history: pd.DataFrame
    schema: dict[str, Any]
    models: dict[str, lgb.Booster]
    version: str

    @classmethod
    def load(cls, root: Path, version: str) -> "ReinRuntime":
        schema = json.loads((root / "schema.json").read_text(encoding="utf-8"))
        history = prepare_inference_history(pd.read_parquet(root / "data" / "history.parquet"))
        models = {role: lgb.Booster(model_file=str(root / "models" / f"{role}.txt"))
                  for role in ("first", "second", "third")}
        return cls(history=history, schema=schema, models=models, version=version)

    def feature_frame(self, race: dict[str, Any], runners: list[dict[str, Any]]) -> pd.DataFrame:
        race_date = pd.Timestamp(race["race_date"])
        history = self.history.loc[self.history["race_date"].lt(race_date)]
        field_size = len(runners)
        max_gate = max((int(runner.get("gate") or 0) for runner in runners), default=1)
        mean_carried = np.nanmean([float(runner.get("weight_carried") or np.nan) for runner in runners])
        mean_weight = np.nanmean([float(runner.get("horse_weight") or np.nan) for runner in runners])
        rows: list[dict[str, Any]] = []

        for runner in runners:
            horse_id = str(runner.get("horse_id", "0")).lstrip("0") or "0"
            jockey_id = str(runner.get("jockey_id", "0")).lstrip("0") or "0"
            trainer_id = str(runner.get("trainer_id", "0")).lstrip("0") or "0"
            horse = history.loc[history["horse_id"].eq(horse_id)].sort_values(["race_date", "race_id"])
            recent5 = horse.tail(5)
            recent3 = horse.tail(3)
            distance = float(race["distance_m"])
            bucket = int(distance // 200)
            row: dict[str, Any] = {
                "racecourse": race["racecourse"], "surface": race["surface"],
                "distance_m": distance, "horse_number": int(runner["horse_number"]),
                "gate": int(runner["gate"]), "age": float(runner.get("age") or np.nan),
                "sex": runner.get("sex") or "__missing__",
                "weight_carried": float(runner.get("weight_carried") or np.nan),
                "going": race.get("going") or "__missing__",
                "race_class": race.get("race_class") or "__missing__",
                "jockey_id": jockey_id, "trainer_id": trainer_id,
                "horse_weight": float(runner.get("horse_weight") or np.nan),
                "horse_weight_change": float(runner.get("horse_weight_change") or np.nan),
                "field_size": float(field_size),
                "horse_number_pct": int(runner["horse_number"]) / field_size,
                "gate_pct": int(runner["gate"]) / max(max_gate, 1),
                "weight_carried_vs_field": float(runner.get("weight_carried") or np.nan) - mean_carried,
                "horse_weight_vs_field": float(runner.get("horse_weight") or np.nan) - mean_weight,
            }
            _put_rate(row, "horse", horse)
            _put_rate(row, "jockey", history.loc[history["jockey_id"].eq(jockey_id)])
            _put_rate(row, "trainer", history.loc[history["trainer_id"].eq(trainer_id)])
            _put_rate(row, "horse_surface", horse.loc[horse["surface"].eq(race["surface"])])
            _put_rate(row, "horse_distance", horse.loc[horse["distance_bucket"].eq(bucket)])
            _put_rate(row, "horse_course", horse.loc[horse["racecourse"].eq(race["racecourse"])])

            previous = horse.iloc[-1] if len(horse) else None
            row["days_since_last_start"] = (race_date - previous["race_date"]).days if previous is not None else math.nan
            row["distance_change_m"] = distance - float(previous["distance_m"]) if previous is not None else math.nan
            row["same_surface_as_last"] = float(previous["surface"] == race["surface"]) if previous is not None else 0.0
            row["same_course_as_last"] = float(previous["racecourse"] == race["racecourse"]) if previous is not None else 0.0
            finish5 = pd.to_numeric(recent5["finish_position"], errors="coerce")
            row["horse_recent5_avg_finish"] = _safe_mean(finish5)
            row["horse_recent5_win_rate"] = float(finish5.eq(1).mean()) if len(finish5) else math.nan
            row["horse_recent5_top3_rate"] = float(finish5.between(1, 3).mean()) if len(finish5) else math.nan
            for signal in SIGNALS:
                row[f"prior_{signal}"] = float(previous[signal]) if previous is not None and pd.notna(previous[signal]) else math.nan
                row[f"recent3_{signal}"] = _safe_mean(recent3[signal])

            window_start = race_date - pd.Timedelta(days=90)
            for entity, entity_id in (("jockey_id", jockey_id), ("trainer_id", trainer_id)):
                window = history.loc[
                    history[entity].eq(entity_id)
                    & history["race_date"].ge(window_start)
                    & history["race_date"].lt(race_date)
                ]
                n = len(window)
                row[f"{entity}_recent90_win"] = float((window["won"].sum() + 1.5) / (n + 20))
                row[f"{entity}_recent90_place"] = float((window["placed"].sum() + 4.5) / (n + 20))

            current_class = float(CLASS_TIER.get(str(race.get("race_class")), math.nan))
            prior_class = float(previous["class_tier_result"]) if previous is not None and pd.notna(previous["class_tier_result"]) else math.nan
            prior_distance = float(previous["distance_m"]) if previous is not None else math.nan
            row.update({
                "class_tier": current_class, "prior_class_tier": prior_class,
                "class_change": current_class - prior_class, "class_rise": max(current_class - prior_class, 0),
                "class_drop": max(prior_class - current_class, 0),
                "recent5_max_class": float(recent5["class_tier_result"].max()) if len(recent5) else math.nan,
                "prior_distance_m": prior_distance, "recent3_distance_m": _safe_mean(recent3["distance_m"]),
                "distance_abs_change": abs(distance - prior_distance),
                "stretching_out": max(distance - prior_distance, 0), "shortening": max(prior_distance - distance, 0),
                "prior_closing3f_relative": float(previous["closing3f_relative"]) if previous is not None and pd.notna(previous["closing3f_relative"]) else math.nan,
                "recent3_closing3f_relative": _safe_mean(recent3["closing3f_relative"]),
                "recent5_closing3f_relative": _safe_mean(recent5["closing3f_relative"]),
                "prior_closing3f_z": float(previous["closing3f_z"]) if previous is not None and pd.notna(previous["closing3f_z"]) else math.nan,
                "recent3_closing3f_z": _safe_mean(recent3["closing3f_z"]),
                "recent5_closing3f_z": _safe_mean(recent5["closing3f_z"]),
                "recent3_result_strength": _safe_mean(recent3["result_strength"]),
            })
            row["class_vs_recent_max"] = current_class - row["recent5_max_class"]
            row["distance_vs_recent3"] = distance - row["recent3_distance_m"]
            rows.append(row)

        frame = pd.DataFrame(rows)
        frame["expected_front_count"] = float(frame["prior_early_pct"].le(.25).sum())
        frame["relative_early"] = frame["prior_early_pct"] - frame["prior_early_pct"].mean()
        frame["front_style"] = frame["prior_early_pct"].le(.25).astype(float)
        frame["stalk_style"] = frame["prior_early_pct"].between(.25, .50, inclusive="right").astype(float)
        frame["closer_style"] = frame["prior_early_pct"].gt(.50).astype(float)
        frame["front_pressure_count"] = float(frame["front_style"].sum())
        frame["front_pressure_share"] = frame["front_pressure_count"] / field_size
        frame["known_style_share"] = float(frame["prior_early_pct"].count()) / field_size
        frame["front_under_pressure"] = frame["front_style"] * frame["front_pressure_share"]
        frame["closer_pressure_help"] = frame["closer_style"] * frame["front_pressure_share"]
        frame["relative_late"] = frame["prior_late_pct"] - frame["prior_late_pct"].mean()
        frame["closing_pressure_fit"] = -frame["recent3_closing3f_z"] * frame["front_pressure_share"]
        for column in CATEGORICAL:
            frame[column] = frame[column].fillna("__missing__").astype("category")
        return frame[self.schema["feature_order"]]

    def score(self, race: dict[str, Any], runners: list[dict[str, Any]]) -> dict[str, Any]:
        frame = self.feature_frame(race, runners)
        role_values = {role: np.clip(model.predict(frame), 1e-12, None)
                       for role, model in self.models.items()}
        normalized = {role: values / values.sum() for role, values in role_values.items()}
        output = []
        for index, runner in enumerate(runners):
            output.append({
                "horse_number": int(runner["horse_number"]),
                "first_probability": float(normalized["first"][index]),
                "second_probability": float(normalized["second"][index]),
                "third_probability": float(normalized["third"][index]),
            })
        return {"version": self.version, "feature_count": len(frame.columns), "runners": output}
