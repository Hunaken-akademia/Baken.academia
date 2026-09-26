from __future__ import annotations
import math
import numpy as np
import pandas as pd
from rein_core import ReinRuntime as BaseRuntime, SIGNALS
from rein_market_score import score_market_difference

def _research_mean(values, window):
    a = pd.to_numeric(values, errors="coerce").to_numpy(float)
    valid = np.isfinite(a)
    cs = np.r_[0.0, np.cumsum(np.where(valid, a, 0.0))]
    cc = np.r_[0, np.cumsum(valid)]
    left = max(0, len(a) - window)
    count = int(cc[-1] - cc[left])
    return float((cs[-1] - cs[left]) / count) if count else math.nan

class ReinRuntime(BaseRuntime):
    def _market_feature_frame(self, full_frame, race, runners, target, columns):
        frame = super()._market_feature_frame(
            full_frame, race, runners, target, columns
        ).copy()
        if "form_surprise_last3" not in frame.columns:
            return frame

        race_date = pd.Timestamp(race["race_date"])
        history = self.history.loc[self.history["race_date"].lt(race_date)]
        for index, runner in enumerate(runners):
            horse_id = str(runner.get("horse_id", "0")).lstrip("0") or "0"
            horse = history.loc[history["horse_id"].eq(horse_id)].sort_values(
                ["race_date", "race_id", "horse_number"], kind="stable"
            )
            finish = pd.to_numeric(horse["finish_position"], errors="coerce")
            surprise = (
                pd.to_numeric(horse["past_popularity"], errors="coerce") - finish
            ) / pd.to_numeric(horse["historical_field_size"], errors="coerce")

            for window in (3, 5, 10):
                for prefix, values in (
                    ("form_surprise", surprise),
                    ("form_speed", horse["speed_relative"]),
                ):
                    key = f"{prefix}_last{window}"
                    if key in frame:
                        frame.loc[index, key] = _research_mean(values, window)

            if "body_weight_vs_recent3" in frame:
                frame.loc[index, "body_weight_vs_recent3"] = (
                    float(runner.get("horse_weight") or np.nan)
                    - _research_mean(horse["horse_weight"], 3)
                )
            if "body_load_change" in frame:
                frame.loc[index, "body_load_change"] = (
                    float(runner.get("weight_carried") or np.nan)
                    - _research_mean(horse["weight_carried"], 1)
                )

            for key, values, window in (
                ("horse_recent5_avg_finish", finish, 5),
                ("horse_recent5_win_rate", finish.eq(1).astype(float), 5),
                ("horse_recent5_top3_rate", finish.between(1, 3).astype(float), 5),
            ):
                if key in frame:
                    frame.loc[index, key] = _research_mean(values, window)

            for position in (1, 2, 3):
                for window in (5, 10):
                    key = f"history_exact_{position}_last{window}"
                    if key in frame:
                        frame.loc[index, key] = _research_mean(
                            finish.eq(position).astype(float), window
                        )

            for signal in SIGNALS:
                key = f"recent3_{signal}"
                if key in frame:
                    frame.loc[index, key] = _research_mean(horse[signal], 3)

            if "recent3_distance_m" in frame:
                frame.loc[index, "recent3_distance_m"] = _research_mean(
                    horse["distance_m"], 3
                )
            for signal in ("closing3f_relative", "closing3f_z"):
                for window in (3, 5):
                    key = f"recent{window}_{signal}"
                    if key in frame:
                        frame.loc[index, key] = _research_mean(
                            horse[signal], window
                        )
            if "recent3_result_strength" in frame:
                frame.loc[index, "recent3_result_strength"] = _research_mean(
                    horse["result_strength"], 3
                )

        if "form_speed_trend" in frame:
            frame["form_speed_trend"] = (
                frame["form_speed_last3"] - frame["form_speed_last10"]
            )
        if "form_surprise_trend" in frame:
            frame["form_surprise_trend"] = (
                frame["form_surprise_last3"] - frame["form_surprise_last10"]
            )
        if "field_speed_std" in frame:
            frame["field_speed_std"] = frame["recent3_speed_relative"].std()

        race_key = pd.Series(0, index=frame.index)
        for column in (
            "recent3_speed_relative", "recent3_closing3f_z", "horse_win_rate",
            "horse_top3_rate", "horse_recent5_avg_finish", "recent3_result_strength",
        ):
            rank_key = f"{column}_field_rank"
            gap_key = f"{column}_field_gap"
            values = pd.to_numeric(frame[column], errors="coerce")
            if rank_key in frame:
                frame[rank_key] = values.groupby(race_key, observed=True).rank(pct=True)
            if gap_key in frame:
                mean = values.groupby(race_key, observed=True).transform("mean")
                frame[gap_key] = values - mean

        if "relative_early" in frame:
            mean = frame["prior_early_pct"].groupby(
                race_key, observed=True
            ).transform("mean")
            frame["relative_early"] = frame["prior_early_pct"] - mean
        if "relative_late" in frame:
            mean = frame["prior_late_pct"].groupby(
                race_key, observed=True
            ).transform("mean")
            frame["relative_late"] = frame["prior_late_pct"] - mean
        if "closing_pressure_fit" in frame:
            frame["closing_pressure_fit"] = (
                -frame["recent3_closing3f_z"] * frame["front_pressure_share"]
            )

        pop = pd.Series(
            [float(r.get("popularity") or np.nan) for r in runners],
            index=frame.index,
        )
        favorite = min(
            frame.index,
            key=lambda i: (pop.loc[i], int(runners[int(i)]["horse_number"])),
        )
        for column in (
            "recent3_speed_relative", "recent3_closing3f_z",
            "horse_top3_rate", "prior_early_pct",
        ):
            key = "matchup_" + column
            if key in frame:
                frame[key] = frame[column] - frame.loc[favorite, column]

        if "market_share" in frame:
            inv = frame["market_inv_rank"]
            denom = inv.groupby(race_key, observed=True).transform("sum")
            frame["market_share"] = inv / denom
        return frame

    def score(self, race, runners):
        base = super().score(race, runners)
        if self.market_models is None:
            base["market_difference_ready"] = False
            return base
        full = self._feature_frame_full(race, runners)
        for column in (
            "racecourse", "going", "race_class", "sex",
            "surface", "jockey_id", "trainer_id",
        ):
            if column in full:
                full[column] = full[column].astype(object)
        scores = score_market_difference(self, full, race, runners)
        weights = {"first": .5, "second": .3, "third": .2}
        market = sum(weights[r] * scores["market"][r] for r in weights)
        edge = sum(
            weights[r] * np.log(scores["rein"][r] / scores["market"][r])
            for r in weights
        )
        difference = market * np.exp(.75 * edge)
        for index, item in enumerate(base["runners"]):
            item["market_difference_score"] = float(difference[index])
            for kind, prefix in (("market", "market"), ("rein", "rein_market")):
                for role in ("first", "second", "third"):
                    item[f"{prefix}_{role}_probability"] = float(
                        scores[kind][role][index]
                    )
        base["market_difference_ready"] = True
        return base
