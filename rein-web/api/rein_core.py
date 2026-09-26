from __future__ import annotations

import json
import math
import ctypes
import gzip
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_libgomp = Path(__file__).resolve().parent / "lib" / "libgomp.so.1"
if _libgomp.is_file():
    ctypes.CDLL(str(_libgomp), mode=ctypes.RTLD_GLOBAL)

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
    second_joint_schema: dict[str, Any]
    second_joint_model: lgb.Booster
    market_models: dict[str, dict[str, lgb.Booster]] | None
    version: str

    @classmethod
    def load(cls, root: Path, version: str) -> "ReinRuntime":
        schema = json.loads((root / "schema.json").read_text(encoding="utf-8"))
        history = prepare_inference_history(pd.read_parquet(root / "data" / "history.parquet"))
        models = {role: lgb.Booster(model_file=str(root / "models" / f"{role}.txt"))
                  for role in ("first", "third")}
        packaged = Path(__file__).resolve().parent / "models"
        second_joint_schema = json.loads(
            (packaged / "second_joint_v5.schema.json").read_text(encoding="utf-8")
        )
        with gzip.open(packaged / "second_joint_v5.txt.gz", "rt", encoding="utf-8") as model_file:
            second_joint_model = lgb.Booster(model_str=model_file.read())
        if second_joint_model.num_feature() != len(second_joint_schema["feature_order"]):
            raise RuntimeError("REIN second-place model schema mismatch")
        market_root = packaged / "market_difference"
        market_models = None
        if market_root.is_dir():
            market_models = {
                role: {
                    "market": lgb.Booster(model_file=str(market_root / f"{role}_market.txt")),
                    "rein": lgb.Booster(model_file=str(market_root / f"{role}_rein.txt")),
                }
                for role in ("first", "second", "third")
            }
        return cls(
            history=history,
            schema=schema,
            models=models,
            second_joint_schema=second_joint_schema,
            second_joint_model=second_joint_model,
            market_models=market_models,
            version=f"{version}+{second_joint_schema['version']}",
        )

    def _feature_frame_full(self, race: dict[str, Any], runners: list[dict[str, Any]]) -> pd.DataFrame:
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
                # A zero change is a real value for the new second-place model.
                "horse_weight_change": (
                    float(runner["horse_weight_change"])
                    if runner.get("horse_weight_change") is not None
                    and runner.get("horse_weight_change") != ""
                    and pd.notna(runner.get("horse_weight_change"))
                    else math.nan
                ),
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
            current_wet = (race.get("going") or "") in ("重", "不良")
            wet_history = horse.loc[horse["going"].isin(["重", "不良"]).eq(current_wet)]
            wet_finish = pd.to_numeric(wet_history["finish_position"], errors="coerce").dropna()
            row["horse_wet_prior_starts"] = float(len(wet_finish))
            row["horse_wet_prior_top3_rate"] = float(
                (wet_finish.between(1, 3).sum() + 4.5) / (len(wet_finish) + 20)
            )

            previous = horse.iloc[-1] if len(horse) else None
            row["days_since_last_start"] = (race_date - previous["race_date"]).days if previous is not None else math.nan
            row["distance_change_m"] = distance - float(previous["distance_m"]) if previous is not None else math.nan
            row["same_surface_as_last"] = float(previous["surface"] == race["surface"]) if previous is not None else 0.0
            row["same_course_as_last"] = float(previous["racecourse"] == race["racecourse"]) if previous is not None else 0.0
            finish5 = pd.to_numeric(recent5["finish_position"], errors="coerce")
            row["horse_recent5_avg_finish"] = _safe_mean(finish5)
            row["horse_recent5_win_rate"] = float(finish5.eq(1).mean()) if len(finish5) else math.nan
            row["horse_recent5_top3_rate"] = float(finish5.between(1, 3).mean()) if len(finish5) else math.nan
            finish_all = pd.to_numeric(horse["finish_position"], errors="coerce")
            for position in (1, 2, 3):
                for window in (5, 10):
                    recent_finish = finish_all.tail(window)
                    row[f"history_exact_{position}_last{window}"] = (
                        float(recent_finish.eq(position).mean()) if len(recent_finish) else math.nan
                    )
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
        for column in (
            "recent3_speed_relative", "recent3_closing3f_z", "horse_win_rate",
            "horse_top3_rate", "horse_recent5_avg_finish", "recent3_result_strength",
        ):
            values = pd.to_numeric(frame[column], errors="coerce")
            frame[f"{column}_field_rank"] = values.rank(pct=True)
            frame[f"{column}_field_gap"] = values - values.mean()
        for column in CATEGORICAL:
            frame[column] = frame[column].fillna("__missing__").astype("category")
        return frame

    def feature_frame(self, race: dict[str, Any], runners: list[dict[str, Any]]) -> pd.DataFrame:
        return self._legacy_feature_frame(self._feature_frame_full(race, runners), runners)

    def _legacy_feature_frame(
        self, full_frame: pd.DataFrame, runners: list[dict[str, Any]]
    ) -> pd.DataFrame:
        """Preserve the existing first/third model inputs byte-for-byte."""
        frame = full_frame[self.schema["feature_order"]].copy()
        if "horse_weight_change" in frame.columns:
            frame["horse_weight_change"] = [
                float(runner.get("horse_weight_change") or np.nan) for runner in runners
            ]
        return frame

    def _market_feature_frame(
        self, full_frame: pd.DataFrame, race: dict[str, Any],
        runners: list[dict[str, Any]], target: int, columns: list[str],
    ) -> pd.DataFrame:
        frame = full_frame.copy()
        # Market-only extension must add missing categories before recategorizing.
        for column in CATEGORICAL:
            if column in frame:
                frame[column] = frame[column].astype(object)
        race_date = pd.Timestamp(race["race_date"])
        history = self.history.loc[self.history["race_date"].lt(race_date)].copy()
        finish = pd.to_numeric(history["finish_position"], errors="coerce")
        history["_target"] = finish.eq(target).astype(float)
        history["_wet_key"] = history["going"].isin(["重", "不良"])
        # Each historical entry uses the style known BEFORE that race.
        historical_prior_early = history.groupby("horse_id", sort=False, observed=True)["early_pct"].shift(1)
        history["_style_key"] = np.select(
            [historical_prior_early.le(.25), historical_prior_early.le(.5), historical_prior_early.gt(.5)],
            [1, 2, 3], default=0,
        )
        current_wet = (race.get("going") or "") in ("重", "不良")
        distance_bucket = int(float(race["distance_m"]) // 200)
        for index, runner in enumerate(runners):
            horse_id = str(runner.get("horse_id", "0")).lstrip("0") or "0"
            horse = history.loc[history["horse_id"].eq(horse_id)].sort_values(["race_date", "race_id"])
            surprise = (
                pd.to_numeric(horse["past_popularity"], errors="coerce")
                - pd.to_numeric(horse["finish_position"], errors="coerce")
            ) / pd.to_numeric(horse["historical_field_size"], errors="coerce")
            for window in (3, 5, 10):
                frame.loc[index, f"form_surprise_last{window}"] = _safe_mean(surprise.tail(window))
                frame.loc[index, f"form_speed_last{window}"] = _safe_mean(horse["speed_relative"].tail(window))
            frame.loc[index, "body_weight_vs_recent3"] = (
                float(runner.get("horse_weight") or np.nan)
                - _safe_mean(pd.to_numeric(horse.get("horse_weight"), errors="coerce").tail(3))
            )
            frame.loc[index, "body_load_change"] = (
                float(runner.get("weight_carried") or np.nan)
                - (float(horse.iloc[-1]["weight_carried"]) if len(horse) and pd.notna(horse.iloc[-1]["weight_carried"]) else math.nan)
            )
            style_key = 1 if frame.loc[index, "prior_early_pct"] <= .25 else 2 if frame.loc[index, "prior_early_pct"] <= .5 else 3 if pd.notna(frame.loc[index, "prior_early_pct"]) else 0
            specs = [
                (history.loc[history["horse_id"].eq(horse_id) & history["surface"].eq(race["surface"])], "fit_surface"),
                (history.loc[history["horse_id"].eq(horse_id) & history["distance_bucket"].eq(distance_bucket)], "fit_distance"),
                (history.loc[history["horse_id"].eq(horse_id) & history["racecourse"].eq(race["racecourse"])], "fit_course"),
                (history.loc[history["horse_id"].eq(horse_id) & history["_wet_key"].eq(current_wet)], "fit_wet"),
                (history.loc[history["racecourse"].eq(race["racecourse"]) & history["surface"].eq(race["surface"]) & history["distance_bucket"].eq(distance_bucket) & pd.to_numeric(history["gate"], errors="coerce").eq(int(runner["gate"]))], "gate_course_bias"),
                (history.loc[history["racecourse"].eq(race["racecourse"]) & history["surface"].eq(race["surface"]) & history["_style_key"].eq(style_key)], "pace_course_style"),
            ]
            for subset, prefix in specs:
                n = float(len(subset))
                frame.loc[index, prefix + "_starts"] = n
                frame.loc[index, prefix + "_rate"] = float((subset["_target"].sum() + 6.4) / (n + 80))
        frame["form_speed_trend"] = frame["form_speed_last3"] - frame["form_speed_last10"]
        frame["form_surprise_trend"] = frame["form_surprise_last3"] - frame["form_surprise_last10"]
        frame["body_change_abs"] = frame["horse_weight_change"].abs()
        frame["body_change_pct"] = frame["horse_weight_change"] / frame["horse_weight"]
        frame["body_load_ratio"] = frame["weight_carried"] / frame["horse_weight"]
        frame["month_sin"] = math.sin(race_date.month * 2 * math.pi / 12)
        frame["month_cos"] = math.cos(race_date.month * 2 * math.pi / 12)
        frame["history_coverage"] = frame["horse_starts"].gt(0).mean()
        frame["field_speed_std"] = frame["recent3_speed_relative"].std()
        pop = pd.Series([float(r.get("popularity") or np.nan) for r in runners], index=frame.index)
        field = float(len(runners))
        frame["market_rank"] = pop
        frame["market_logrank"] = np.log(pop.clip(lower=1))
        frame["market_inv_rank"] = 1 / pop.clip(lower=1)
        frame["market_share"] = frame["market_inv_rank"] / frame["market_inv_rank"].sum()
        frame["market_rank_fraction"] = pop / field
        frame["market_field_size"] = field
        favorite_index = pop.idxmin()
        for column in ("recent3_speed_relative", "recent3_closing3f_z", "horse_top3_rate", "prior_early_pct"):
            frame["matchup_" + column] = frame[column] - frame.loc[favorite_index, column]
        odds = pd.Series([float(r.get("win_odds") or np.nan) for r in runners], index=frame.index)
        if not np.isfinite(odds).all() or (odds < 1).any():
            raise ValueError("Validated win odds are required for market-difference ranking")
        share = (1 / odds) / (1 / odds).sum()
        frame["odds_log_win"] = np.log(odds)
        frame["odds_win_share"] = share
        frame["odds_favorite_share"] = share.max()
        frame["odds_entropy"] = float((-share * np.log(share)).sum())
        frame["odds_concentration"] = float((share ** 2).sum())
        frame["odds_relative_to_favorite"] = np.log(share / share.max())
        frame["odds_log_rank"] = np.log(odds.rank(method="min"))
        frame = _align_market_history_precision(self, frame, race, runners)
        for column in CATEGORICAL:
            if column in frame:
                frame[column] = frame[column].fillna("__missing__").astype("category")
        missing = [column for column in columns if column not in frame]
        if missing:
            raise RuntimeError("Market model features are unavailable: " + ",".join(missing[:5]))
        return frame[columns]

    def score(self, race: dict[str, Any], runners: list[dict[str, Any]]) -> dict[str, Any]:
        full_frame = self._feature_frame_full(race, runners)
        frame = self._legacy_feature_frame(full_frame, runners)
        third_order = self.schema.get("role_feature_order", {}).get(
            "third", self.schema["feature_order"]
        )
        third_frame = full_frame[third_order]
        role_values = {
            "first": np.clip(self.models["first"].predict(frame), 1e-12, None),
            "third": np.clip(self.models["third"].predict(third_frame), 1e-12, None),
        }
        second_frame = full_frame[self.second_joint_schema["feature_order"]]
        second_output = self.second_joint_model.predict(second_frame)
        if second_output.ndim != 2 or second_output.shape[1] <= int(self.second_joint_schema["second_class_index"]):
            raise RuntimeError("REIN second-place model returned invalid output")
        role_values["second"] = np.clip(
            second_output[:, int(self.second_joint_schema["second_class_index"])], 1e-12, None
        )
        normalized = {role: values / values.sum() for role, values in role_values.items()}
        market_difference = None
        if self.market_models and market_inputs_valid(runners):
            market_values = {}
            rein_values = {}
            for role, target in (("first", 1), ("second", 2), ("third", 3)):
                market_model = self.market_models[role]["market"]
                rein_model = self.market_models[role]["rein"]
                market_frame = self._market_feature_frame(full_frame, race, runners, target, market_model.feature_name())
                rein_frame = self._market_feature_frame(full_frame, race, runners, target, rein_model.feature_name())
                market_values[role] = np.clip(market_model.predict(market_frame), 1e-12, None)
                rein_values[role] = np.clip(rein_model.predict(rein_frame), 1e-12, None)
            for role in ("first", "second", "third"):
                market_values[role] /= market_values[role].sum()
                rein_values[role] /= rein_values[role].sum()
            weights = {"first": .5, "second": .3, "third": .2}
            market_composite = sum(weights[r] * market_values[r] for r in weights)
            edge = sum(weights[r] * np.log(rein_values[r] / market_values[r]) for r in weights)
            market_difference = market_composite * np.exp(.75 * edge)
        contribution_frames = {
            "first": (self.models["first"].predict(frame, pred_contrib=True), list(frame.columns)),
            "third": (self.models["third"].predict(third_frame, pred_contrib=True), list(third_frame.columns)),
        }
        second_contribution = self.second_joint_model.predict(second_frame, pred_contrib=True)
        second_width = len(second_frame.columns) + 1
        second_class = int(self.second_joint_schema["second_class_index"])
        if second_contribution.ndim == 3:
            second_contribution = second_contribution[:, second_class, :]
        elif second_contribution.ndim == 2 and second_contribution.shape[1] > second_width:
            start = second_class * second_width
            second_contribution = second_contribution[:, start:start + second_width]
        contribution_frames["second"] = (second_contribution, list(second_frame.columns))
        def local_reasons(role, index):
            values, columns = contribution_frames[role]
            row = np.asarray(values[index])[:-1]
            order = np.argsort(np.abs(row))[::-1][:5]
            return [{"feature": columns[int(i)], "contribution": float(row[int(i)])} for i in order if np.isfinite(row[int(i)])]
        output = []
        for index, runner in enumerate(runners):
            output.append({
                "horse_number": int(runner["horse_number"]),
                "first_probability": float(normalized["first"][index]),
                "second_probability": float(normalized["second"][index]),
                "third_probability": float(normalized["third"][index]),
                "first_reasons": local_reasons("first", index),
                "second_reasons": local_reasons("second", index),
                "third_reasons": local_reasons("third", index),
                "market_difference_score": float(market_difference[index]) if market_difference is not None else None,
            })
        return {"version": self.version, "feature_count": len(frame.columns), "runners": output}


# MARKET_HISTORY_PRECISION_V1: match the frozen research accumulation order.
def market_inputs_valid(runners):
    """Market-difference models need a published popularity and win odds for every runner.

    Missing values are never filled in; the caller skips only the market-difference
    ranking and keeps the odds-independent first/second/third role models.
    """
    for runner in runners:
        try:
            popularity = float(runner.get("popularity") or np.nan)
            odds = float(runner.get("win_odds") or np.nan)
        except (TypeError, ValueError):
            return False
        if not (np.isfinite(popularity) and popularity >= 1 and np.isfinite(odds) and odds >= 1):
            return False
    return True


def _market_precision_cache(runtime):
    cached = getattr(runtime, "_market_precision_cache_v1", None)
    if cached is not None:
        return cached
    ordered = runtime.history.sort_values(
        ["horse_id", "race_date", "race_id", "horse_number"], kind="stable"
    ).reset_index(drop=True)
    horse_ids = ordered["horse_id"].astype(str).to_numpy()
    starts = np.r_[0, np.flatnonzero(horse_ids[1:] != horse_ids[:-1]) + 1]
    ends = np.r_[starts[1:], len(ordered)]
    bounds = {str(horse_ids[start]): (int(start), int(end)) for start, end in zip(starts, ends)} if len(ordered) else {}
    values = {column: pd.to_numeric(ordered[column], errors="coerce").to_numpy(float)
              for column in set(SIGNALS) | {"finish_position", "distance_m", "closing3f_relative",
                  "closing3f_z", "result_strength", "horse_weight", "weight_carried"}}
    values["form_surprise"] = (
        pd.to_numeric(ordered["past_popularity"], errors="coerce").to_numpy(float)
        - values["finish_position"]
    ) / pd.to_numeric(ordered["historical_field_size"], errors="coerce").to_numpy(float)
    prefix = {}
    for column, array in values.items():
        modes = (False, True) if column in ("form_surprise", "speed_relative") else (False,)
        for finite_only in modes:
            valid = np.isfinite(array) if finite_only else ~np.isnan(array)
            prefix[(column, finite_only)] = (
                np.r_[0., np.cumsum(np.where(valid, array, 0.))],
                np.r_[0, np.cumsum(valid)],
            )
    cached = {"bounds": bounds, "dates": ordered["race_date"].to_numpy(dtype="datetime64[ns]"), "prefix": prefix}
    runtime._market_precision_cache_v1 = cached
    return cached


def _align_market_history_precision(runtime, frame, race, runners):
    # Use an independent copy: first/second/third legacy suitability is not modified.
    frame = frame.copy()
    cached = _market_precision_cache(runtime)
    cutoff = np.datetime64(pd.Timestamp(race["race_date"]), "ns")
    normalized_ids = [str(runner.get("horse_id", "0")).lstrip("0") or "0" for runner in runners]
    ranges = []
    for horse_id in normalized_ids:
        start, end = cached["bounds"].get(horse_id, (0, 0))
        stop = start + int(np.searchsorted(cached["dates"][start:end], cutoff, side="left"))
        ranges.append((start, stop))
    def mean(column, window, finite_only=False):
        total, count = cached["prefix"][(column, finite_only)]
        result = []
        for start, stop in ranges:
            left = max(start, stop-window)
            denominator = count[stop]-count[left]
            result.append((total[stop]-total[left])/denominator if denominator else np.nan)
        return np.asarray(result, float)
    for signal in SIGNALS:
        frame["recent3_" + signal] = mean(signal, 3)
    frame["horse_recent5_avg_finish"] = mean("finish_position", 5)
    frame["horse_recent5_win_rate"] = mean("won", 5)
    frame["horse_recent5_top3_rate"] = mean("placed", 5)
    frame["recent3_distance_m"] = mean("distance_m", 3)
    frame["distance_vs_recent3"] = frame["distance_m"]-frame["recent3_distance_m"]
    for signal in ("closing3f_relative", "closing3f_z"):
        for window in (3, 5):
            frame[f"recent{window}_{signal}"] = mean(signal, window)
    frame["recent3_result_strength"] = mean("result_strength", 3)
    for window in (3, 5, 10):
        frame[f"form_surprise_last{window}"] = mean("form_surprise", window, True)
        frame[f"form_speed_last{window}"] = mean("speed_relative", window, True)
    frame["form_speed_trend"] = frame["form_speed_last3"]-frame["form_speed_last10"]
    frame["form_surprise_trend"] = frame["form_surprise_last3"]-frame["form_surprise_last10"]
    frame["body_weight_vs_recent3"] = frame["horse_weight"]-mean("horse_weight", 3)
    frame["body_load_change"] = frame["weight_carried"]-mean("weight_carried", 1)
    frame["closing_pressure_fit"] = -frame["recent3_closing3f_z"]*frame["front_pressure_share"]
    order = np.argsort(np.asarray(normalized_ids, dtype=str), kind="stable")
    groups = np.zeros(len(frame), dtype=np.int8)
    def grouped(column, operation):
        series = frame.iloc[order][column]
        return series.groupby(groups, observed=True, sort=False).transform(operation).reindex(frame.index)
    for column in ("recent3_speed_relative", "recent3_closing3f_z", "horse_win_rate", "horse_top3_rate",
                   "horse_recent5_avg_finish", "recent3_result_strength"):
        frame[column + "_field_rank"] = frame[column].rank(pct=True)
        frame[column + "_field_gap"] = frame[column]-grouped(column, "mean")
    for prefix in ("early", "late"):
        column = "prior_" + prefix + "_pct"
        frame["relative_" + prefix] = frame[column]-grouped(column, "mean")
    for column in ("weight_carried", "horse_weight"):
        frame[column + "_vs_field"] = frame[column]-grouped(column, "mean")
    frame["field_speed_std"] = grouped("recent3_speed_relative", "std")
    frame["market_share"] = frame["market_inv_rank"]/grouped("market_inv_rank", "sum")
    favorite = min(range(len(runners)), key=lambda i: (float(runners[i].get("popularity") or np.inf), int(runners[i]["horse_number"])))
    favorite_index = frame.index[favorite]
    for column in ("recent3_speed_relative", "recent3_closing3f_z", "horse_top3_rate", "prior_early_pct"):
        frame["matchup_" + column] = frame[column]-frame.loc[favorite_index, column]
    month = pd.Timestamp(race["race_date"]).month
    frame["month_sin"] = np.sin(month*2*np.pi/12)
    frame["month_cos"] = np.cos(month*2*np.pi/12)
    return frame
