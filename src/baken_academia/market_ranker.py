from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from .features import build_feature_frame
from .history_features import add_point_in_time_features
from .ranking_quality import _method_metrics, _prepare
from .schema import validate_input
from .train import split_by_date


def relevance_labels(finish_position: pd.Series) -> pd.Series:
    finish = pd.to_numeric(finish_position, errors="coerce")
    return pd.Series(
        np.select(
            [finish.eq(1), finish.eq(2), finish.eq(3)],
            [3, 2, 1],
            default=0,
        ),
        index=finish.index,
        dtype=int,
    )


def _market_features(df: pd.DataFrame, x: pd.DataFrame) -> pd.DataFrame:
    enriched = x.copy()
    popularity = pd.to_numeric(df.get("popularity"), errors="coerce")
    field_size = pd.to_numeric(df["field_size"], errors="coerce").clip(lower=1)
    enriched["popularity"] = popularity
    enriched["popularity_pct"] = popularity / field_size
    enriched["market_strength"] = 1.0 / popularity.clip(lower=1)
    return enriched


def _ordered_subset(
    df: pd.DataFrame,
    x: pd.DataFrame,
    labels: pd.Series,
    mask: np.ndarray,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series, list[int]]:
    selected = df.loc[mask].copy()
    selected["_source_index"] = selected.index
    selected = selected.sort_values(["race_id", "horse_number"], kind="mergesort")
    ordered_x = x.loc[selected["_source_index"]].copy()
    ordered_labels = labels.loc[selected["_source_index"]].copy()
    groups = selected.groupby("race_id", observed=True, sort=False).size().astype(int).tolist()
    return selected.drop(columns="_source_index"), ordered_x, ordered_labels, groups


def _probabilities(scores: np.ndarray, race_ids: pd.Series) -> np.ndarray:
    values = pd.Series(scores, index=race_ids.index, dtype=float)
    maximum = values.groupby(race_ids, observed=True).transform("max")
    exponent = np.exp(np.clip(values - maximum, -40.0, 40.0))
    denominator = exponent.groupby(race_ids, observed=True).transform("sum")
    return (exponent / denominator).to_numpy()


def train(input_path: Path, output_dir: Path) -> dict[str, object]:
    import lightgbm as lgb

    raw = pd.read_parquet(input_path)
    if "is_dead_heat" in raw.columns:
        raw = raw.loc[~raw["is_dead_heat"].fillna(False).astype(bool)].copy()
    df = add_point_in_time_features(validate_input(raw))
    base_x, _, categorical = build_feature_frame(df)
    x = _market_features(df, base_x)
    labels = relevance_labels(df["finish_position"])
    train_mask, validation_mask, test_mask = split_by_date(df)

    train_df, train_x, train_y, train_groups = _ordered_subset(df, x, labels, train_mask)
    validation_df, validation_x, validation_y, validation_groups = _ordered_subset(
        df, x, labels, validation_mask
    )
    test_df, test_x, _test_y, _test_groups = _ordered_subset(df, x, labels, test_mask)

    model = lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1, 3, 7],
        n_estimators=1600,
        learning_rate=0.025,
        num_leaves=31,
        min_child_samples=80,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=0.2,
        reg_lambda=1.0,
        random_state=456,
        n_jobs=-1,
        verbosity=-1,
    )
    model.fit(
        train_x,
        train_y,
        group=train_groups,
        categorical_feature=categorical,
        eval_set=[(validation_x, validation_y)],
        eval_group=[validation_groups],
        eval_at=[1, 3],
        callbacks=[lgb.early_stopping(100, verbose=False)],
    )

    scores = model.predict(test_x, num_iteration=model.best_iteration_)
    predictions = test_df[["race_id", "race_date", "horse_id"]].copy()
    predictions["win_probability"] = _probabilities(scores, test_df["race_id"])
    ranked = _prepare(predictions, raw)

    periods = {
        "all_held_out": ranked,
        "test_2026": ranked.loc[ranked["race_date"].ge("2026-01-01")],
    }
    report: dict[str, object] = {
        "description": "人気を事前特徴に含むレース内LambdaRankモデル",
        "target": "1着=3, 2着=2, 3着=1, 4着以下=0",
        "date_ranges": {
            "train": [str(train_df["race_date"].min().date()), str(train_df["race_date"].max().date())],
            "validation": [
                str(validation_df["race_date"].min().date()),
                str(validation_df["race_date"].max().date()),
            ],
            "test": [str(test_df["race_date"].min().date()), str(test_df["race_date"].max().date())],
        },
        "best_iteration": int(model.best_iteration_ or model.n_estimators),
        "features": list(x.columns),
        "periods": {},
    }
    for name, period in periods.items():
        if period.empty:
            continue
        report["periods"][name] = {
            "market_ranker": _method_metrics(period, "rein_rank"),
            "popularity": _method_metrics(period, "popularity_rank"),
        }

    importance = pd.DataFrame(
        {
            "feature": model.feature_name_,
            "gain": model.booster_.feature_importance(importance_type="gain"),
        }
    ).sort_values("gain", ascending=False)
    total_gain = importance["gain"].sum()
    importance["gain_share"] = importance["gain"] / total_gain if total_gain else 0.0

    output_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, output_dir / "model.joblib")
    predictions.to_parquet(output_dir / "test_predictions.parquet", index=False)
    importance.to_csv(output_dir / "feature-importance.csv", index=False)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="人気を基準にREIN補正を学ぶレース内ランキングモデル")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(train(args.input, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
