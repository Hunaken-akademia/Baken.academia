from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .ranking_quality import _method_metrics, _prepare


ALPHAS = tuple(round(value, 2) for value in np.linspace(0.0, 1.0, 21))


def _scores(frame: pd.DataFrame, alpha: float) -> pd.Series:
    market = 1.0 / frame["popularity_sort"].clip(lower=1.0)
    market = market / market.groupby(frame["race_id"], observed=True).transform("sum")
    model = frame["win_probability"].clip(lower=1e-12)
    model = model / model.groupby(frame["race_id"], observed=True).transform("sum")
    return (1.0 - alpha) * market + alpha * model


def _rank(frame: pd.DataFrame, alpha: float, column: str = "blend_rank") -> pd.DataFrame:
    ranked = frame.copy()
    ranked["blend_score"] = _scores(ranked, alpha)
    ranked = ranked.sort_values(
        ["race_id", "blend_score", "horse_id"],
        ascending=[True, False, True],
        kind="mergesort",
    )
    ranked[column] = ranked.groupby("race_id", observed=True).cumcount() + 1
    return ranked


def _role_rank(
    frame: pd.DataFrame,
    first_alpha: float,
    top3_alpha: float,
    column: str = "hybrid_rank",
) -> pd.DataFrame:
    ranked = frame.copy()
    ranked["first_score"] = _scores(ranked, first_alpha)
    ranked["top3_score"] = _scores(ranked, top3_alpha)
    ranked = ranked.sort_values(
        ["race_id", "first_score", "horse_id"],
        ascending=[True, False, True],
        kind="mergesort",
    )
    ranked["is_first"] = ranked.groupby("race_id", observed=True).cumcount().eq(0)
    first = ranked.loc[ranked["is_first"]].copy()
    first[column] = 1
    remainder = ranked.loc[~ranked["is_first"]].sort_values(
        ["race_id", "top3_score", "horse_id"],
        ascending=[True, False, True],
        kind="mergesort",
    )
    remainder[column] = remainder.groupby("race_id", observed=True).cumcount() + 2
    return pd.concat([first, remainder], ignore_index=True).sort_values(
        ["race_date", "race_id", column]
    )


def _first_objective(metrics: dict[str, object]) -> tuple[float, float]:
    race = metrics["race_level"]
    return float(race["top1_win_rate"]), float(race["top1_top3_rate"])


def _top3_objective(metrics: dict[str, object]) -> tuple[float, float, float, float]:
    race = metrics["race_level"]
    return (
        float(race["average_actual_top3_captured"]),
        float(race["top3_contains_winner_rate"]),
        float(race["top3_two_or_more_placed_rate"]),
        float(race["top3_all_placed_rate"]),
    )


def tune(validation: pd.DataFrame) -> dict[str, object]:
    candidates = []
    for alpha in ALPHAS:
        ranked = _rank(validation, alpha)
        metrics = _method_metrics(ranked, "blend_rank")
        candidates.append({"alpha": alpha, "metrics": metrics})

    # Smaller REIN weight wins an exact tie, keeping the market anchor stable.
    best_first = max(candidates, key=lambda row: (*_first_objective(row["metrics"]), -row["alpha"]))
    best_top3 = max(candidates, key=lambda row: (*_top3_objective(row["metrics"]), -row["alpha"]))
    return {
        "first_alpha": float(best_first["alpha"]),
        "top3_alpha": float(best_top3["alpha"]),
        "candidates": candidates,
    }


def evaluate(
    predictions_path: Path,
    races_path: Path,
    output_dir: Path,
) -> dict[str, object]:
    frame = _prepare(pd.read_parquet(predictions_path), pd.read_parquet(races_path))
    validation = frame.loc[frame["race_date"].lt("2026-01-01")].copy()
    test = frame.loc[frame["race_date"].ge("2026-01-01")].copy()
    if validation.empty or test.empty:
        raise ValueError("2026年より前の調整期間と2026年未使用テストの両方が必要です")

    tuning = tune(validation)
    first_alpha = float(tuning["first_alpha"])
    top3_alpha = float(tuning["top3_alpha"])

    validation_hybrid = _role_rank(validation, first_alpha, top3_alpha)
    test_hybrid = _role_rank(test, first_alpha, top3_alpha)
    report = {
        "description": "人気を土台にREINを加える役割別ハイブリッド順位",
        "selection_policy": {
            "tuning_period": "held-out predictionのうち2026-01-01より前",
            "final_test_period": "2026-01-01以降（比率選択には不使用）",
            "first_alpha": first_alpha,
            "top3_alpha": top3_alpha,
            "alpha_definition": "0=人気のみ、1=REINのみ",
        },
        "validation": {
            "hybrid": _method_metrics(validation_hybrid, "hybrid_rank"),
            "popularity": _method_metrics(validation, "popularity_rank"),
            "rein": _method_metrics(validation, "rein_rank"),
        },
        "test_2026": {
            "hybrid": _method_metrics(test_hybrid, "hybrid_rank"),
            "popularity": _method_metrics(test, "popularity_rank"),
            "rein": _method_metrics(test, "rein_rank"),
        },
        "tuning_candidates": tuning["candidates"],
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    pd.concat(
        [
            validation_hybrid.assign(period="validation"),
            test_hybrid.assign(period="test_2026"),
        ],
        ignore_index=True,
    ).to_parquet(output_dir / "hybrid-ranked-runners.parquet", index=False)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="人気とREINの役割別混合比率を過去側だけで調整")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--races", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(evaluate(args.predictions, args.races, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
