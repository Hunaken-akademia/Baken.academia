from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression


def normalize_per_race(values: np.ndarray, race_ids: pd.Series) -> np.ndarray:
    frame = pd.DataFrame({"race_id": race_ids.to_numpy(), "value": np.clip(values, 1e-9, None)})
    denominator = frame.groupby("race_id", observed=True)["value"].transform("sum")
    return (frame["value"] / denominator).to_numpy()


def select_bets(frame: pd.DataFrame, threshold: float) -> pd.DataFrame:
    candidates = frame.copy()
    candidates["expected_value"] = candidates["calibrated_probability"] * candidates["win_odds"]
    best = candidates.loc[candidates.groupby("race_id", observed=True)["expected_value"].idxmax()].copy()
    return best.loc[best["expected_value"] >= threshold].sort_values(["race_date", "race_id"])


def evaluate_bets(bets: pd.DataFrame, stake_yen: int = 100) -> dict[str, float | int]:
    if bets.empty:
        return {
            "bets": 0,
            "hits": 0,
            "hit_rate": 0.0,
            "stake_yen": 0,
            "return_yen": 0.0,
            "profit_yen": 0.0,
            "return_rate": 0.0,
            "max_drawdown_yen": 0.0,
        }
    returns = np.where(bets["is_win"].astype(bool), bets["win_odds"] * stake_yen, 0.0)
    profit = returns - stake_yen
    cumulative = np.cumsum(profit)
    peaks = np.maximum.accumulate(np.r_[0.0, cumulative])[:-1]
    drawdown = peaks - cumulative
    total_stake = len(bets) * stake_yen
    total_return = float(returns.sum())
    return {
        "bets": int(len(bets)),
        "hits": int(bets["is_win"].sum()),
        "hit_rate": float(bets["is_win"].mean()),
        "stake_yen": int(total_stake),
        "return_yen": total_return,
        "profit_yen": total_return - total_stake,
        "return_rate": total_return / total_stake,
        "max_drawdown_yen": float(drawdown.max(initial=0.0)),
    }


def choose_threshold(
    frame: pd.DataFrame,
    thresholds: np.ndarray | None = None,
    min_bets: int = 100,
) -> tuple[float, list[dict[str, float | int]]]:
    thresholds = thresholds if thresholds is not None else np.arange(1.0, 2.01, 0.05)
    scans: list[dict[str, float | int]] = []
    for threshold in thresholds:
        bets = select_bets(frame, float(threshold))
        metrics = evaluate_bets(bets)
        if metrics["bets"]:
            multiples = np.where(bets["is_win"].astype(bool), bets["win_odds"], 0.0)
            lower_bound = float(np.mean(multiples) - 1.96 * np.std(multiples) / np.sqrt(len(multiples)))
        else:
            lower_bound = None
        scans.append({"threshold": round(float(threshold), 2), "lower_bound": lower_bound, **metrics})
    eligible = [row for row in scans if int(row["bets"]) >= min_bets]
    if not eligible:
        eligible = [row for row in scans if int(row["bets"]) > 0]
    if not eligible:
        raise ValueError("期待値閾値を選択できる検証ベットがありません")
    best = max(eligible, key=lambda row: (float(row["lower_bound"]), float(row["return_rate"])))
    return float(best["threshold"]), scans


def build_expected_value_policy(
    predictions_path: Path,
    odds_paths: list[Path],
    output_dir: Path,
) -> dict[str, object]:
    predictions = pd.read_parquet(predictions_path)
    odds = pd.concat([pd.read_parquet(path) for path in odds_paths], ignore_index=True)
    for frame in (predictions, odds):
        frame["race_id"] = frame["race_id"].astype(str)
        frame["horse_id"] = frame["horse_id"].astype(str)
        frame["race_date"] = pd.to_datetime(frame["race_date"])
    odds = odds.drop_duplicates(["race_id", "horse_id"], keep="last")
    merged = predictions.merge(
        odds[["race_id", "horse_id", "win_odds"]],
        on=["race_id", "horse_id"],
        how="left",
        validate="one_to_one",
    )
    eligible = merged.loc[merged["win_odds"].notna() & (merged["win_odds"] > 0)].copy()
    if eligible.empty:
        raise ValueError("予測とJRA最終単勝オッズを結合できません")

    calibration = eligible.loc[eligible["race_date"] < "2025-08-01"].copy()
    policy_validation = eligible.loc[
        eligible["race_date"].between("2025-08-01", "2025-12-31")
    ].copy()
    test = eligible.loc[eligible["race_date"] >= "2026-01-01"].copy()
    if min(calibration["race_id"].nunique(), policy_validation["race_id"].nunique(), test["race_id"].nunique()) == 0:
        raise ValueError("較正・方針検証・最終テストのいずれかが空です")

    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=1e-6, y_max=1 - 1e-6)
    calibrator.fit(calibration["win_probability"], calibration["is_win"])
    for frame in (calibration, policy_validation, test):
        calibrated = calibrator.predict(frame["win_probability"])
        frame["calibrated_probability"] = normalize_per_race(calibrated, frame["race_id"])

    threshold, threshold_scan = choose_threshold(policy_validation)
    validation_bets = select_bets(policy_validation, threshold)
    test_bets = select_bets(test, threshold)
    baseline = test.loc[test.groupby("race_id", observed=True)["win_probability"].idxmax()].copy()

    output_dir.mkdir(parents=True, exist_ok=True)
    policy = {
        "calibrator": calibrator,
        "expected_value_threshold": threshold,
        "stake_yen": 100,
        "one_bet_per_race": True,
    }
    joblib.dump(policy, output_dir / "expected-value-policy.joblib")
    test_bets.to_parquet(output_dir / "test-bets.parquet", index=False)
    coverage = len(eligible) / len(merged)
    report = {
        "policy": {
            "expected_value_threshold": threshold,
            "selection": "各レースで期待値最大の1頭、閾値以上のみ",
            "stake_yen": 100,
            "probability_calibration": "isotonic; 2025-03-01 through 2025-07-31",
            "threshold_selection": "95% lower confidence bound; 2025-08-01 through 2025-12-31",
            "final_test": "2026-01-01 onward",
        },
        "coverage": {
            "prediction_rows": int(len(merged)),
            "rows_with_final_win_odds": int(len(eligible)),
            "ratio": float(coverage),
        },
        "validation": evaluate_bets(validation_bets),
        "test": evaluate_bets(test_bets),
        "test_top_probability_baseline": evaluate_bets(baseline),
        "threshold_scan": threshold_scan,
        "leakage_guard": "final odds are used only for bet selection/evaluation, never as win-model features",
    }
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA勝率と最終単勝オッズから期待値方針を検証します")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--odds", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = build_expected_value_policy(args.predictions, args.odds, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
