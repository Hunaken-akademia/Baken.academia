from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class TicketPlan:
    main: int = 30
    counter: int = 30
    longshot: int = 30
    main_heads: int = 3
    counter_heads: int = 5


def ordered_probability(first: float, second: float, third: float) -> float:
    """Plackett-Luce approximation for an exact first-second-third order."""
    after_first = max(1.0 - first, 1e-12)
    after_second = max(1.0 - first - second, 1e-12)
    return float(first * (second / after_first) * (third / after_second))


def _all_orders(runners: pd.DataFrame) -> pd.DataFrame:
    ranked = runners.sort_values(["win_probability", "horse_number"], ascending=[False, True]).copy()
    ranked["rank"] = np.arange(1, len(ranked) + 1)
    records: list[dict[str, object]] = []
    values = ranked[["horse_number", "win_probability", "rank"]].to_dict("records")
    for first, second, third in itertools.permutations(values, 3):
        probability = ordered_probability(
            float(first["win_probability"]),
            float(second["win_probability"]),
            float(third["win_probability"]),
        )
        ranks = (int(first["rank"]), int(second["rank"]), int(third["rank"]))
        records.append(
            {
                "first": int(first["horse_number"]),
                "second": int(second["horse_number"]),
                "third": int(third["horse_number"]),
                "first_rank": ranks[0],
                "second_rank": ranks[1],
                "third_rank": ranks[2],
                "order_probability": probability,
                # Give a small lift to plausible orders containing a lower-ranked horse.
                "longshot_score": probability * (1.0 + 0.10 * max(ranks[0] - 3, 0)
                                                    + 0.05 * max(ranks[1] - 5, 0)
                                                    + 0.03 * max(ranks[2] - 7, 0)),
            }
        )
    return pd.DataFrame(records)


def generate_tickets(runners: pd.DataFrame, plan: TicketPlan = TicketPlan()) -> pd.DataFrame:
    required = {"race_id", "race_date", "horse_number", "win_probability"}
    missing = sorted(required - set(runners.columns))
    if missing:
        raise ValueError(f"三連単生成に必要な列が不足しています: {', '.join(missing)}")
    if runners["race_id"].nunique() != 1:
        raise ValueError("generate_tickets は1レースずつ呼び出してください")
    if len(runners) < 3:
        return pd.DataFrame()

    orders = _all_orders(runners)
    selected: list[pd.DataFrame] = []

    main_pool = orders.loc[
        (orders["first_rank"] <= plan.main_heads)
        & (orders["second_rank"] <= 6)
        & (orders["third_rank"] <= 8)
    ].nlargest(plan.main, "order_probability")
    main_pool = main_pool.assign(ticket_type="main")
    selected.append(main_pool)
    used = set(map(tuple, main_pool[["first", "second", "third"]].to_numpy()))

    counter_pool = orders.loc[
        (orders["first_rank"] <= plan.counter_heads)
        & (orders["second_rank"] <= 8)
        & (orders["third_rank"] <= 10)
    ].sort_values("order_probability", ascending=False)
    counter_pool = counter_pool.loc[
        ~counter_pool[["first", "second", "third"]].apply(tuple, axis=1).isin(used)
    ].head(plan.counter).assign(ticket_type="counter")
    selected.append(counter_pool)
    used.update(map(tuple, counter_pool[["first", "second", "third"]].to_numpy()))

    longshot_pool = orders.loc[
        (orders["first_rank"] > plan.main_heads)
        | (orders["second_rank"] > 6)
        | (orders["third_rank"] > 8)
    ].sort_values(["longshot_score", "order_probability"], ascending=False)
    longshot_pool = longshot_pool.loc[
        ~longshot_pool[["first", "second", "third"]].apply(tuple, axis=1).isin(used)
    ].head(plan.longshot).assign(ticket_type="longshot")
    selected.append(longshot_pool)

    tickets = pd.concat(selected, ignore_index=True)
    tickets.insert(0, "race_date", pd.to_datetime(runners["race_date"].iloc[0]))
    tickets.insert(0, "race_id", str(runners["race_id"].iloc[0]))
    return tickets.sort_values(["ticket_type", "order_probability"], ascending=[True, False])


def _metrics(tickets: pd.DataFrame, payouts: pd.DataFrame, stake_yen: int) -> dict[str, object]:
    if tickets.empty:
        return {"races": 0, "tickets": 0, "hits": 0, "race_hit_rate": 0.0,
                "ticket_hit_rate": 0.0, "stake_yen": 0, "return_yen": 0,
                "profit_yen": 0, "return_rate": 0.0, "max_drawdown_yen": 0}
    keys = ["race_id", "first", "second", "third"]
    paid = payouts[keys + ["payout_yen_per_100"]].drop_duplicates(keys)
    checked = tickets.merge(paid, on=keys, how="left")
    checked["hit"] = checked["payout_yen_per_100"].notna()
    checked["return_yen"] = checked["payout_yen_per_100"].fillna(0) * (stake_yen / 100)
    per_race = checked.groupby(["race_date", "race_id"], observed=True).agg(
        tickets=("hit", "size"), hits=("hit", "sum"), return_yen=("return_yen", "sum")
    ).reset_index().sort_values(["race_date", "race_id"])
    per_race["stake_yen"] = per_race["tickets"] * stake_yen
    per_race["profit_yen"] = per_race["return_yen"] - per_race["stake_yen"]
    cumulative = per_race["profit_yen"].cumsum().to_numpy()
    peaks = np.maximum.accumulate(np.r_[0.0, cumulative])[:-1]
    total_stake = int(per_race["stake_yen"].sum())
    total_return = int(round(per_race["return_yen"].sum()))
    hits = int(checked["hit"].sum())
    return {
        "races": int(per_race["race_id"].nunique()),
        "tickets": int(len(checked)),
        "average_tickets_per_race": float(len(checked) / per_race["race_id"].nunique()),
        "hits": hits,
        "race_hit_rate": float((per_race["hits"] > 0).mean()),
        "ticket_hit_rate": float(hits / len(checked)),
        "stake_yen": total_stake,
        "return_yen": total_return,
        "profit_yen": total_return - total_stake,
        "return_rate": float(total_return / total_stake) if total_stake else 0.0,
        "max_drawdown_yen": int(round((peaks - cumulative).max(initial=0.0))),
    }


def evaluate_trifecta(
    predictions_path: Path,
    races_path: Path,
    payouts_path: Path,
    output_dir: Path,
    plan: TicketPlan = TicketPlan(),
    stake_yen: int = 100,
) -> dict[str, object]:
    predictions = pd.read_parquet(predictions_path)
    races = pd.read_parquet(races_path)
    payouts = pd.read_parquet(payouts_path)
    for frame in (predictions, races, payouts):
        frame["race_id"] = frame["race_id"].astype(str)
    predictions["race_date"] = pd.to_datetime(predictions["race_date"])
    races["race_date"] = pd.to_datetime(races["race_date"])
    runners = predictions.merge(
        races[["race_id", "horse_id", "horse_number", "finish_position"]],
        on=["race_id", "horse_id"], how="left", validate="one_to_one",
    )
    runners = runners.dropna(subset=["horse_number", "win_probability"])
    ticket_frames = [generate_tickets(group, plan) for _, group in runners.groupby("race_id", observed=True)]
    tickets = pd.concat([frame for frame in ticket_frames if not frame.empty], ignore_index=True)

    output_dir.mkdir(parents=True, exist_ok=True)
    tickets.to_parquet(output_dir / "tickets.parquet", index=False)
    dates = pd.to_datetime(tickets["race_date"])
    periods = {
        "validation": tickets.loc[dates < "2026-01-01"],
        "test_2026": tickets.loc[dates >= "2026-01-01"],
    }
    report: dict[str, object] = {
        "policy": {**asdict(plan), "stake_yen_per_ticket": stake_yen,
                   "probability": "Plackett-Luce from leakage-safe win probabilities"},
        "periods": {},
    }
    for period_name, period_tickets in periods.items():
        period_report: dict[str, object] = {}
        for ticket_type in ("main", "counter", "longshot"):
            period_report[ticket_type] = _metrics(
                period_tickets.loc[period_tickets["ticket_type"] == ticket_type], payouts, stake_yen
            )
        period_report["combined"] = _metrics(period_tickets, payouts, stake_yen)
        report["periods"][period_name] = period_report
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA三連単の本線・対抗・穴を生成して検証します")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--races", type=Path, required=True)
    parser.add_argument("--payouts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stake-yen", type=int, default=100)
    args = parser.parse_args()
    report = evaluate_trifecta(
        args.predictions, args.races, args.payouts, args.output, stake_yen=args.stake_yen
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
