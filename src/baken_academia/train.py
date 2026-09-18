from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

from .features import build_feature_frame
from .schema import validate_input


def split_by_date(
    df: pd.DataFrame, train_fraction: float = 0.60, validation_fraction: float = 0.20
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    dates = np.array(sorted(df["race_date"].drop_duplicates()))
    if len(dates) < 30:
        raise ValueError("時系列評価には30開催日以上のデータが必要です")

    train_end = max(1, int(len(dates) * train_fraction))
    validation_end = max(train_end + 1, int(len(dates) * (train_fraction + validation_fraction)))
    validation_end = min(validation_end, len(dates) - 1)

    train_dates = set(dates[:train_end])
    validation_dates = set(dates[train_end:validation_end])
    test_dates = set(dates[validation_end:])
    return (
        df["race_date"].isin(train_dates).to_numpy(),
        df["race_date"].isin(validation_dates).to_numpy(),
        df["race_date"].isin(test_dates).to_numpy(),
    )


def normalize_per_race(raw: np.ndarray, race_ids: pd.Series) -> np.ndarray:
    frame = pd.DataFrame({"race_id": race_ids.to_numpy(), "raw": np.clip(raw, 1e-9, None)})
    denominator = frame.groupby("race_id", observed=True)["raw"].transform("sum")
    return (frame["raw"] / denominator).to_numpy()


def evaluate(df: pd.DataFrame, y: pd.Series, probability: np.ndarray) -> dict[str, float | int]:
    normalized = normalize_per_race(probability, df["race_id"])
    evaluation = df[["race_id", "horse_id", "finish_position"]].copy()
    evaluation["probability"] = normalized
    picked = evaluation.loc[evaluation.groupby("race_id")["probability"].idxmax()]

    return {
        "rows": int(len(df)),
        "races": int(df["race_id"].nunique()),
        "log_loss": float(log_loss(y, np.clip(probability, 1e-7, 1 - 1e-7))),
        "brier_score": float(brier_score_loss(y, probability)),
        "roc_auc": float(roc_auc_score(y, probability)),
        "top1_winner_accuracy": float((picked["finish_position"] == 1).mean()),
    }


def train(input_path: Path, output_dir: Path) -> dict[str, object]:
    import lightgbm as lgb

    raw = (
        pd.read_parquet(input_path)
        if input_path.suffix.lower() in {".parquet", ".pq"}
        else pd.read_csv(input_path, low_memory=False)
    )
    df = validate_input(raw)
    x, y, categorical = build_feature_frame(df)
    train_mask, validation_mask, test_mask = split_by_date(df)

    model = lgb.LGBMClassifier(
        objective="binary",
        n_estimators=2_000,
        learning_rate=0.025,
        num_leaves=31,
        max_depth=-1,
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
        x.loc[train_mask],
        y.loc[train_mask],
        categorical_feature=categorical,
        eval_set=[(x.loc[validation_mask], y.loc[validation_mask])],
        callbacks=[lgb.early_stopping(100, verbose=False)],
    )

    validation_probability = model.predict_proba(x.loc[validation_mask])[:, 1]
    test_probability = model.predict_proba(x.loc[test_mask])[:, 1]
    metrics = {
        "validation": evaluate(
            df.loc[validation_mask], y.loc[validation_mask], validation_probability
        ),
        "test": evaluate(df.loc[test_mask], y.loc[test_mask], test_probability),
        "date_ranges": {
            "train": [str(df.loc[train_mask, "race_date"].min().date()), str(df.loc[train_mask, "race_date"].max().date())],
            "validation": [str(df.loc[validation_mask, "race_date"].min().date()), str(df.loc[validation_mask, "race_date"].max().date())],
            "test": [str(df.loc[test_mask, "race_date"].min().date()), str(df.loc[test_mask, "race_date"].max().date())],
        },
        "features": list(x.columns),
        "best_iteration": int(model.best_iteration_ or model.n_estimators),
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, output_dir / "model.joblib")
    (output_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    predictions = df.loc[test_mask, ["race_id", "race_date", "horse_id"]].copy()
    predictions["is_win"] = y.loc[test_mask].to_numpy()
    predictions["win_probability"] = normalize_per_race(
        test_probability, df.loc[test_mask, "race_id"]
    )
    predictions.to_parquet(output_dir / "test_predictions.parquet", index=False)
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="馬券アカデミアの勝率モデルを学習します")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("artifacts/latest"))
    args = parser.parse_args()
    metrics = train(args.input, args.output)
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
