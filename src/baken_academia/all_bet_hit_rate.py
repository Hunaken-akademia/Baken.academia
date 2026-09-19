from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from .trifecta import ordered_probability


@dataclass(frozen=True)
class BetCaps:
    main: int
    counter: int
    longshot: int


BET_CAPS = {
    "win": BetCaps(1, 1, 1),
    "place": BetCaps(1, 1, 2),
    "bracket_quinella": BetCaps(3, 4, 5),
    "quinella": BetCaps(5, 6, 8),
    "wide": BetCaps(4, 5, 7),
    "exacta": BetCaps(8, 10, 12),
    "trio": BetCaps(10, 12, 15),
    "trifecta": BetCaps(15, 22, 30),
}

BET_LABELS = {
    "win": "単勝", "place": "複勝", "bracket_quinella": "枠連",
    "quinella": "馬連", "wide": "ワイド", "exacta": "馬単",
    "trio": "三連複", "trifecta": "三連単",
}


def _aggregate(records: list[tuple[tuple[int, ...], float, tuple[int, ...]]]) -> pd.DataFrame:
    values: dict[tuple[int, ...], dict[str, object]] = {}
    for selection, probability, ranks in records:
        row = values.setdefault(selection, {"probability": 0.0, "ranks": ranks})
        row["probability"] = float(row["probability"]) + probability
        if (sum(ranks), max(ranks)) < (sum(row["ranks"]), max(row["ranks"])):
            row["ranks"] = ranks
    rows = []
    for selection, value in values.items():
        ranks = tuple(int(rank) for rank in value["ranks"])
        rows.append({
            "selection": selection,
            "probability": float(value["probability"]),
            "rank_sum": sum(ranks),
            "max_rank": max(ranks),
        })
    return pd.DataFrame(rows)


def _candidates(runners: pd.DataFrame) -> dict[str, pd.DataFrame]:
    ranked = runners.sort_values(["win_probability", "horse_number"], ascending=[False, True])
    values = []
    for rank, row in enumerate(ranked.itertuples(), 1):
        values.append({"horse": int(row.horse_number), "gate": int(row.gate),
                       "probability": float(row.win_probability), "rank": rank})

    singles = [(v["horse"], v["probability"], v["rank"]) for v in values]
    pair_orders: list[tuple[dict, dict, float]] = []
    for first, second in itertools.permutations(values, 2):
        probability = first["probability"] * second["probability"] / max(
            1.0 - first["probability"], 1e-12
        )
        pair_orders.append((first, second, probability))

    triple_orders: list[tuple[dict, dict, dict, float]] = []
    for first, second, third in itertools.permutations(values, 3):
        probability = ordered_probability(first["probability"], second["probability"],
                                          third["probability"])
        triple_orders.append((first, second, third, probability))

    frames: dict[str, pd.DataFrame] = {}
    for bet_type in ("win", "place"):
        frames[bet_type] = pd.DataFrame({
            "selection": [(horse,) for horse, _, _ in singles],
            "probability": [probability for _, probability, _ in singles],
            "rank_sum": [rank for _, _, rank in singles],
            "max_rank": [rank for _, _, rank in singles],
        })
    frames["exacta"] = _aggregate([
        ((first["horse"], second["horse"]), probability, (first["rank"], second["rank"]))
        for first, second, probability in pair_orders
    ])
    frames["quinella"] = _aggregate([
        (tuple(sorted((first["horse"], second["horse"]))), probability,
         (first["rank"], second["rank"]))
        for first, second, probability in pair_orders
    ])
    frames["bracket_quinella"] = _aggregate([
        (tuple(sorted((first["gate"], second["gate"]))), probability,
         (first["rank"], second["rank"]))
        for first, second, probability in pair_orders
    ])
    frames["trifecta"] = _aggregate([
        ((first["horse"], second["horse"], third["horse"]), probability,
         (first["rank"], second["rank"], third["rank"]))
        for first, second, third, probability in triple_orders
    ])
    frames["trio"] = _aggregate([
        (tuple(sorted((first["horse"], second["horse"], third["horse"]))), probability,
         (first["rank"], second["rank"], third["rank"]))
        for first, second, third, probability in triple_orders
    ])
    frames["wide"] = _aggregate([
        (pair, probability, ranks)
        for first, second, third, probability in triple_orders
        for pair, ranks in (
            (tuple(sorted((first["horse"], second["horse"]))), (first["rank"], second["rank"])),
            (tuple(sorted((first["horse"], third["horse"]))), (first["rank"], third["rank"])),
            (tuple(sorted((second["horse"], third["horse"]))), (second["rank"], third["rank"])),
        )
    ])
    return frames


def generate_all_bet_tickets(runners: pd.DataFrame) -> pd.DataFrame:
    required = {"race_id", "race_date", "horse_number", "gate", "win_probability"}
    missing = sorted(required - set(runners.columns))
    if missing:
        raise ValueError(f"全券種買い目生成に必要な列が不足しています: {', '.join(missing)}")
    if runners["race_id"].nunique() != 1:
        raise ValueError("1レースずつ呼び出してください")
    candidates = _candidates(runners.dropna(subset=["horse_number", "gate", "win_probability"]))
    output = []
    for bet_type, frame in candidates.items():
        caps = BET_CAPS[bet_type]
        remaining = frame.sort_values(["probability", "rank_sum"], ascending=[False, True]).copy()
        main = remaining.head(caps.main).assign(ticket_type="main")
        remaining = remaining.loc[~remaining["selection"].isin(main["selection"])]
        counter = remaining.head(caps.counter).assign(ticket_type="counter")
        remaining = remaining.loc[~remaining["selection"].isin(counter["selection"])]
        remaining["longshot_score"] = remaining["probability"] * (
            1.0 + 0.12 * (remaining["max_rank"] - 3).clip(lower=0)
            + 0.04 * (remaining["rank_sum"] - 6).clip(lower=0)
        )
        longshot = remaining.sort_values(
            ["longshot_score", "probability"], ascending=False
        ).head(caps.longshot).assign(ticket_type="longshot")
        picked = pd.concat([main, counter, longshot], ignore_index=True)
        picked.insert(0, "bet_type", bet_type)
        output.append(picked)
    tickets = pd.concat(output, ignore_index=True)
    tickets.insert(0, "race_date", pd.to_datetime(runners["race_date"].iloc[0]))
    tickets.insert(0, "race_id", str(runners["race_id"].iloc[0]))
    return tickets


def _outcomes(races: pd.DataFrame) -> pd.DataFrame:
    placed = races.loc[races["finish_position"].isin([1, 2, 3])].copy()
    counts = placed.groupby(["race_id", "finish_position"], observed=True).size().unstack(fill_value=0)
    valid = counts.index[(counts.get(1, 0) == 1) & (counts.get(2, 0) == 1) & (counts.get(3, 0) == 1)]
    placed = placed.loc[placed["race_id"].isin(valid)]
    results = []
    for race_id, group in placed.groupby("race_id", observed=True):
        ordered = group.sort_values("finish_position")
        horses = [int(value) for value in ordered["horse_number"]]
        gates = [int(value) for value in ordered["gate"]]
        winning = {
            "win": {(horses[0],)},
            "place": {(horse,) for horse in horses},
            "bracket_quinella": {tuple(sorted(gates[:2]))},
            "quinella": {tuple(sorted(horses[:2]))},
            "wide": {tuple(sorted(pair)) for pair in itertools.combinations(horses, 2)},
            "exacta": {tuple(horses[:2])},
            "trio": {tuple(sorted(horses))},
            "trifecta": {tuple(horses)},
        }
        for bet_type, selections in winning.items():
            for selection in selections:
                results.append({"race_id": str(race_id), "bet_type": bet_type,
                                "selection": selection})
    return pd.DataFrame(results)


def _metrics(tickets: pd.DataFrame, outcomes: pd.DataFrame) -> dict[str, object]:
    races = tickets["race_id"].nunique()
    if not races:
        return {"races": 0, "average_tickets_per_race": 0.0, "race_hits": 0,
                "race_hit_rate": 0.0, "winning_tickets": 0, "ticket_hit_rate": 0.0}
    checked = tickets.merge(outcomes.assign(hit=True),
                            on=["race_id", "bet_type", "selection"], how="left")
    checked["hit"] = checked["hit"].eq(True)
    per_race = checked.groupby("race_id", observed=True)["hit"].any()
    return {
        "races": int(races),
        "average_tickets_per_race": float(len(tickets) / races),
        "race_hits": int(per_race.sum()),
        "race_hit_rate": float(per_race.mean()),
        "winning_tickets": int(checked["hit"].sum()),
        "ticket_hit_rate": float(checked["hit"].mean()),
    }


def evaluate(predictions_path: Path, races_path: Path, output_dir: Path) -> dict[str, object]:
    predictions = pd.read_parquet(predictions_path)
    races = pd.read_parquet(races_path)
    for frame in (predictions, races):
        frame["race_id"] = frame["race_id"].astype(str)
    predictions["race_date"] = pd.to_datetime(predictions["race_date"])
    races["finish_position"] = pd.to_numeric(races["finish_position"], errors="coerce")
    runners = predictions.merge(
        races[["race_id", "horse_id", "horse_number", "gate"]],
        on=["race_id", "horse_id"], how="left", validate="one_to_one",
    )
    ticket_frames = [generate_all_bet_tickets(group) for _, group in runners.groupby("race_id", observed=True)]
    tickets = pd.concat(ticket_frames, ignore_index=True)
    outcomes = _outcomes(races)
    dates = pd.to_datetime(tickets["race_date"])
    periods = {"validation": tickets.loc[dates < "2026-01-01"],
               "test_2026": tickets.loc[dates >= "2026-01-01"]}
    report: dict[str, object] = {
        "caps": {bet: caps.__dict__ for bet, caps in BET_CAPS.items()}, "periods": {}
    }
    for period_name, period in periods.items():
        period_report = {}
        for bet_type in BET_CAPS:
            bet = period.loc[period["bet_type"] == bet_type]
            rows = {ticket_type: _metrics(
                bet.loc[bet["ticket_type"] == ticket_type], outcomes
            ) for ticket_type in ("main", "counter", "longshot")}
            rows["combined"] = _metrics(bet, outcomes)
            period_report[bet_type] = rows
        report["periods"][period_name] = period_report
    output_dir.mkdir(parents=True, exist_ok=True)
    tickets.to_parquet(output_dir / "tickets.parquet", index=False)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA全8券種の本線・対抗・穴の的中率を検証します")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--races", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(evaluate(args.predictions, args.races, args.output),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
