from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


METHOD_LABELS = {"rein": "REIN評価", "popularity": "人気順"}
RANKS = (1, 2, 3)


def _prepare(predictions: pd.DataFrame, races: pd.DataFrame) -> pd.DataFrame:
    required_predictions = {"race_id", "race_date", "horse_id", "win_probability"}
    required_races = {"race_id", "horse_id", "finish_position", "popularity"}
    missing_predictions = required_predictions - set(predictions.columns)
    missing_races = required_races - set(races.columns)
    if missing_predictions:
        raise ValueError(f"predictionsに必要な列がありません: {sorted(missing_predictions)}")
    if missing_races:
        raise ValueError(f"racesに必要な列がありません: {sorted(missing_races)}")

    predictions = predictions.copy()
    races = races.copy()
    for frame in (predictions, races):
        frame["race_id"] = frame["race_id"].astype(str)
        frame["horse_id"] = frame["horse_id"].astype(str)
    predictions["race_date"] = pd.to_datetime(predictions["race_date"], errors="raise")
    races["finish_position"] = pd.to_numeric(races["finish_position"], errors="coerce")
    races["popularity"] = pd.to_numeric(races["popularity"], errors="coerce")

    columns = ["race_id", "horse_id", "finish_position", "popularity"]
    optional = ["horse_number", "racecourse", "surface", "distance_m"]
    columns.extend(column for column in optional if column in races.columns)
    frame = predictions.merge(
        races[columns],
        on=["race_id", "horse_id"],
        how="inner",
        validate="one_to_one",
    )
    frame = frame.loc[frame["finish_position"].notna() & frame["finish_position"].gt(0)].copy()
    frame["win_probability"] = pd.to_numeric(frame["win_probability"], errors="coerce")
    frame = frame.loc[frame["win_probability"].notna()].copy()

    # Stable ordering makes equal scores reproducible without using the result.
    frame = frame.sort_values(
        ["race_id", "win_probability", "horse_id"],
        ascending=[True, False, True],
        kind="mergesort",
    )
    frame["rein_rank"] = frame.groupby("race_id", observed=True).cumcount() + 1

    fallback = frame.groupby("race_id", observed=True)["popularity"].transform("max").fillna(99) + 1
    frame["popularity_sort"] = frame["popularity"].fillna(fallback)
    frame = frame.sort_values(
        ["race_id", "popularity_sort", "horse_id"],
        ascending=[True, True, True],
        kind="mergesort",
    )
    frame["popularity_rank"] = frame.groupby("race_id", observed=True).cumcount() + 1
    return frame.sort_values(["race_date", "race_id", "rein_rank"]).reset_index(drop=True)


def _rank_rows(frame: pd.DataFrame, rank_column: str) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for rank in RANKS:
        selected = frame.loc[frame[rank_column].eq(rank)]
        starts = len(selected)
        rows.append(
            {
                "rank": rank,
                "runners": int(starts),
                "wins": int(selected["finish_position"].eq(1).sum()),
                "win_rate": float(selected["finish_position"].eq(1).mean()) if starts else 0.0,
                "top2": int(selected["finish_position"].le(2).sum()),
                "top2_rate": float(selected["finish_position"].le(2).mean()) if starts else 0.0,
                "top3": int(selected["finish_position"].le(3).sum()),
                "top3_rate": float(selected["finish_position"].le(3).mean()) if starts else 0.0,
                "average_finish": float(selected["finish_position"].mean()) if starts else 0.0,
            }
        )
    return rows


def _race_metrics(frame: pd.DataFrame, rank_column: str) -> dict[str, object]:
    rows = []
    for race_id, group in frame.groupby("race_id", observed=True):
        picked = group.loc[group[rank_column].le(3)]
        if len(picked) < 3:
            continue
        winner_rows = group.loc[group["finish_position"].eq(1)]
        actual_top3 = set(group.loc[group["finish_position"].le(3), "horse_id"])
        picked_ids = set(picked["horse_id"])
        captured = len(picked_ids & actual_top3)
        rows.append(
            {
                "race_id": race_id,
                "top1_win": bool(picked.loc[picked[rank_column].eq(1), "finish_position"].eq(1).any()),
                "top1_top3": bool(picked.loc[picked[rank_column].eq(1), "finish_position"].le(3).any()),
                "top3_contains_winner": bool(set(winner_rows["horse_id"]) & picked_ids),
                "top3_placed_count": captured,
                "top3_two_or_more_placed": captured >= 2,
                "top3_all_placed": bool(picked["finish_position"].le(3).all()),
            }
        )
    races = pd.DataFrame(rows)
    if races.empty:
        return {
            "races": 0,
            "top1_win_rate": 0.0,
            "top1_top3_rate": 0.0,
            "top3_contains_winner_rate": 0.0,
            "average_actual_top3_captured": 0.0,
            "top3_two_or_more_placed_rate": 0.0,
            "top3_all_placed_rate": 0.0,
        }
    return {
        "races": int(len(races)),
        "top1_win_rate": float(races["top1_win"].mean()),
        "top1_top3_rate": float(races["top1_top3"].mean()),
        "top3_contains_winner_rate": float(races["top3_contains_winner"].mean()),
        "average_actual_top3_captured": float(races["top3_placed_count"].mean()),
        "top3_two_or_more_placed_rate": float(races["top3_two_or_more_placed"].mean()),
        "top3_all_placed_rate": float(races["top3_all_placed"].mean()),
    }


def _method_metrics(frame: pd.DataFrame, rank_column: str) -> dict[str, object]:
    return {
        "by_evaluation_rank": _rank_rows(frame, rank_column),
        "race_level": _race_metrics(frame, rank_column),
    }


def evaluate(
    predictions_path: Path,
    races_path: Path,
    output_dir: Path,
) -> dict[str, object]:
    predictions = pd.read_parquet(predictions_path)
    races = pd.read_parquet(races_path)
    frame = _prepare(predictions, races)

    periods = {"all_held_out": frame}
    test_2026 = frame.loc[frame["race_date"].ge("2026-01-01")]
    if not test_2026.empty:
        periods["test_2026"] = test_2026

    report: dict[str, object] = {
        "description": "REIN評価上位3頭の順位品質を、未使用データで人気順と比較",
        "leakage_policy": "学習時に分離したheld-out予測のみを使用",
        "periods": {},
    }
    csv_rows = []
    for period_name, period in periods.items():
        period_report = {}
        for method, rank_column in (("rein", "rein_rank"), ("popularity", "popularity_rank")):
            metrics = _method_metrics(period, rank_column)
            period_report[method] = metrics
            for row in metrics["by_evaluation_rank"]:
                csv_rows.append(
                    {
                        "period": period_name,
                        "method": method,
                        "method_label": METHOD_LABELS[method],
                        **row,
                    }
                )
        report["periods"][period_name] = period_report

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    pd.DataFrame(csv_rows).to_csv(output_dir / "rank-metrics.csv", index=False)
    frame.to_parquet(output_dir / "ranked-runners.parquet", index=False)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="REIN評価トップ3の1着率・連対率・3連対率を検証")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--races", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = evaluate(args.predictions, args.races, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
