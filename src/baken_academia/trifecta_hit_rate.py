from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .trifecta import TicketPlan, generate_tickets


def _outcomes(races: pd.DataFrame) -> pd.DataFrame:
    placed = races.loc[races["finish_position"].isin([1, 2, 3]),
                       ["race_id", "finish_position", "horse_number"]].copy()
    counts = placed.groupby(["race_id", "finish_position"], observed=True).size().unstack(fill_value=0)
    valid_ids = counts.index[(counts.get(1, 0) == 1) & (counts.get(2, 0) == 1) & (counts.get(3, 0) == 1)]
    placed = placed.loc[placed["race_id"].isin(valid_ids)]
    wide = placed.pivot(index="race_id", columns="finish_position", values="horse_number").reset_index()
    return wide.rename(columns={1: "first", 2: "second", 3: "third"})


def _metrics(tickets: pd.DataFrame, outcomes: pd.DataFrame) -> dict[str, object]:
    if tickets.empty:
        return {"races": 0, "tickets": 0, "hits": 0, "race_hit_rate": 0.0,
                "ticket_hit_rate": 0.0, "average_tickets_per_race": 0.0}
    winning = outcomes.assign(hit=True)
    checked = tickets.merge(winning, on=["race_id", "first", "second", "third"], how="left")
    checked["hit"] = checked["hit"].fillna(False).astype(bool)
    race_hits = checked.groupby("race_id", observed=True)["hit"].any()
    return {
        "races": int(race_hits.size),
        "tickets": int(len(checked)),
        "average_tickets_per_race": float(len(checked) / race_hits.size),
        "hits": int(race_hits.sum()),
        "race_hit_rate": float(race_hits.mean()),
        "ticket_hit_rate": float(checked["hit"].mean()),
    }


def evaluate_hit_rate(
    predictions_path: Path,
    races_path: Path,
    output_dir: Path,
    plan: TicketPlan = TicketPlan(),
) -> dict[str, object]:
    predictions = pd.read_parquet(predictions_path)
    races = pd.read_parquet(races_path)
    for frame in (predictions, races):
        frame["race_id"] = frame["race_id"].astype(str)
    predictions["race_date"] = pd.to_datetime(predictions["race_date"])
    races["finish_position"] = pd.to_numeric(races["finish_position"], errors="coerce")
    runners = predictions.merge(
        races[["race_id", "horse_id", "horse_number"]],
        on=["race_id", "horse_id"], how="left", validate="one_to_one",
    ).dropna(subset=["horse_number", "win_probability"])
    frames = [generate_tickets(group, plan) for _, group in runners.groupby("race_id", observed=True)]
    tickets = pd.concat([frame for frame in frames if not frame.empty], ignore_index=True)
    outcomes = _outcomes(races)

    report: dict[str, object] = {"policy": {
        "main": plan.main, "counter": plan.counter, "longshot": plan.longshot,
        "main_heads": plan.main_heads, "counter_heads": plan.counter_heads,
    }, "periods": {}}
    dates = pd.to_datetime(tickets["race_date"])
    periods = {"validation": tickets.loc[dates < "2026-01-01"],
               "test_2026": tickets.loc[dates >= "2026-01-01"]}
    for name, subset in periods.items():
        result: dict[str, object] = {}
        for ticket_type in ("main", "counter", "longshot"):
            result[ticket_type] = _metrics(
                subset.loc[subset["ticket_type"] == ticket_type], outcomes
            )
        result["combined"] = _metrics(subset, outcomes)
        report["periods"][name] = result
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "hit-rate-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA三連単の本線・対抗・穴の的中率を先行検証します")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--races", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(evaluate_hit_rate(args.predictions, args.races, args.output),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
