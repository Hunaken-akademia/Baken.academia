from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .all_bet_hit_rate import BET_CAPS, _aggregate, generate_all_bet_tickets
from .history_features import add_point_in_time_features


METHOD_LABELS = {
    "wake": "WAKE技術移植",
    "popularity": "人気順",
    "current": "従来方式",
}
GROUPS = ("main", "counter", "longshot")
BLEND_CANDIDATES = (0.25, 0.50, 0.75, 1.00, 1.25)


def _rank_signal(values: pd.Series, *, higher_is_better: bool = True) -> pd.Series:
    numeric = pd.to_numeric(values, errors="coerce")
    ranked = numeric.rank(pct=True, method="average", ascending=higher_is_better)
    return ranked.fillna(0.5).clip(0.0, 1.0)


def _mean_signal(frame: pd.DataFrame, columns: list[str], *, invert: set[str] | None = None) -> pd.Series:
    invert = invert or set()
    signals = []
    for column in columns:
        if column not in frame:
            continue
        signals.append(_rank_signal(frame[column], higher_is_better=column not in invert))
    if not signals:
        return pd.Series(0.5, index=frame.index)
    return pd.concat(signals, axis=1).mean(axis=1)


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - np.nanmax(values)
    exp = np.exp(np.clip(shifted, -40.0, 40.0))
    return exp / exp.sum()


def wake_position_probabilities(runners: pd.DataFrame, blend: float) -> pd.DataFrame:
    """Create WAKE-style role-specific probabilities using only pre-race data.

    WAKE's transferable ideas are retained: several independent axes, different
    second/third-place roles, a two-of-three reinforcement, and shrinkage-aware
    history. Boat-specific rules are deliberately not copied into horse racing.
    """

    frame = runners.copy()
    base = pd.to_numeric(frame["win_probability"], errors="coerce").fillna(0.0).clip(1e-9)
    base = base / base.sum()

    ability = _rank_signal(base)
    recent = _mean_signal(
        frame,
        ["horse_recent5_win_rate", "horse_recent5_top3_rate", "horse_recent5_avg_finish"],
        invert={"horse_recent5_avg_finish"},
    )
    stability = _mean_signal(frame, ["horse_win_rate", "horse_top3_rate"])
    connections = _mean_signal(
        frame,
        ["jockey_win_rate", "jockey_top3_rate", "trainer_win_rate", "trainer_top3_rate"],
    )
    fit = _mean_signal(
        frame,
        ["horse_surface_top3_rate", "horse_distance_top3_rate", "horse_course_top3_rate"],
    )

    votes = (
        (recent >= 0.67).astype(int)
        + (stability >= 0.67).astype(int)
        + (fit >= 0.67).astype(int)
    )
    reinforce = (votes >= 2).astype(float) - (votes == 0).astype(float) * 0.35
    centered = lambda value: value.to_numpy(dtype=float) - 0.5
    log_base = np.log(base.to_numpy(dtype=float))

    first_logit = log_base + blend * (
        0.65 * centered(ability)
        + 0.80 * centered(recent)
        + 0.55 * centered(stability)
        + 0.65 * centered(connections)
        + 0.70 * centered(fit)
        + 0.18 * reinforce.to_numpy(dtype=float)
    )
    second_logit = 0.78 * log_base + blend * (
        0.65 * centered(ability)
        + 1.25 * centered(recent)
        + 1.45 * centered(stability)
        + 0.85 * centered(connections)
        + 0.95 * centered(fit)
        + 0.30 * reinforce.to_numpy(dtype=float)
    )
    third_logit = 0.58 * log_base + blend * (
        0.35 * centered(ability)
        + 1.10 * centered(recent)
        + 1.60 * centered(stability)
        + 0.90 * centered(connections)
        + 1.10 * centered(fit)
        + 0.38 * reinforce.to_numpy(dtype=float)
    )

    roles = pd.DataFrame(
        {
            "horse_number": frame["horse_number"].astype(int).to_numpy(),
            "gate": frame["gate"].astype(int).to_numpy(),
            "first_probability": _softmax(first_logit),
            "second_probability": _softmax(second_logit),
            "third_probability": _softmax(third_logit),
            "model_rank": base.rank(method="first", ascending=False).astype(int).to_numpy(),
            "reinforcement": reinforce.to_numpy(dtype=float),
        }
    )
    # WAKE builds tickets from a controlled candidate pool. Horse racing fields
    # are much larger than boat-racing fields, so retain the strongest six win
    # candidates and three additional horses with clear 2nd/3rd-place support.
    if len(roles) > 9:
        fixed = set(roles.nlargest(6, "first_probability").index)
        remainder = roles.loc[~roles.index.isin(fixed)].copy()
        remainder["tail_support"] = (
            0.45 * remainder["second_probability"]
            + 0.55 * remainder["third_probability"]
            + 0.01 * remainder["reinforcement"].clip(lower=0)
        )
        selected = sorted(fixed | set(remainder.nlargest(3, "tail_support").index))
        roles = roles.loc[selected].copy()
        for column in ("first_probability", "second_probability", "third_probability"):
            roles[column] = roles[column] / roles[column].sum()
    return roles.reset_index(drop=True)


def _role_candidates(runners: pd.DataFrame, blend: float) -> dict[str, pd.DataFrame]:
    roles = wake_position_probabilities(runners, blend)
    values = roles.to_dict("records")
    pair_orders: list[tuple[dict, dict, float]] = []
    for first, second in itertools.permutations(values, 2):
        denominator = max(1.0 - second["second_probability"], 1e-12)
        probability = first["first_probability"] * second["second_probability"] / denominator
        pair_orders.append((first, second, probability))

    triple_orders: list[tuple[dict, dict, dict, float]] = []
    for first, second, third in itertools.permutations(values, 3):
        d2 = max(1.0 - second["second_probability"], 1e-12)
        d3 = max(
            1.0 - first["third_probability"] - second["third_probability"], 1e-12
        )
        probability = (
            first["first_probability"]
            * second["second_probability"] / d2
            * third["third_probability"] / d3
        )
        triple_orders.append((first, second, third, probability))

    total = sum(row[3] for row in triple_orders)
    if total > 0:
        triple_orders = [(a, b, c, p / total) for a, b, c, p in triple_orders]
    pair_total = sum(row[2] for row in pair_orders)
    if pair_total > 0:
        pair_orders = [(a, b, p / pair_total) for a, b, p in pair_orders]

    def ranks(*rows: dict) -> tuple[int, ...]:
        return tuple(int(row["model_rank"]) for row in rows)

    frames: dict[str, pd.DataFrame] = {}
    frames["win"] = _aggregate([
        ((int(row["horse_number"]),), float(row["first_probability"]), ranks(row))
        for row in values
    ])
    frames["place"] = _aggregate([
        ((int(row["horse_number"]),), probability, ranks(row))
        for first, second, third, probability in triple_orders
        for row in (first, second, third)
    ])
    frames["exacta"] = _aggregate([
        ((int(first["horse_number"]), int(second["horse_number"])), probability, ranks(first, second))
        for first, second, probability in pair_orders
    ])
    frames["quinella"] = _aggregate([
        (tuple(sorted((int(first["horse_number"]), int(second["horse_number"])))), probability, ranks(first, second))
        for first, second, probability in pair_orders
    ])
    frames["bracket_quinella"] = _aggregate([
        (tuple(sorted((int(first["gate"]), int(second["gate"])))), probability, ranks(first, second))
        for first, second, probability in pair_orders
    ])
    frames["trifecta"] = _aggregate([
        ((int(first["horse_number"]), int(second["horse_number"]), int(third["horse_number"])), probability, ranks(first, second, third))
        for first, second, third, probability in triple_orders
    ])
    frames["trio"] = _aggregate([
        (tuple(sorted((int(first["horse_number"]), int(second["horse_number"]), int(third["horse_number"])))), probability, ranks(first, second, third))
        for first, second, third, probability in triple_orders
    ])
    frames["wide"] = _aggregate([
        (tuple(sorted((int(a["horse_number"]), int(b["horse_number"])))), probability, ranks(a, b))
        for first, second, third, probability in triple_orders
        for a, b in ((first, second), (first, third), (second, third))
    ])
    return frames


def _pick_groups(frame: pd.DataFrame, bet_type: str) -> pd.DataFrame:
    caps = BET_CAPS[bet_type]
    remaining = frame.sort_values(["probability", "rank_sum"], ascending=[False, True]).copy()
    main = remaining.head(caps.main).assign(ticket_type="main")
    remaining = remaining.loc[~remaining["selection"].isin(main["selection"])]
    counter = remaining.head(caps.counter).assign(ticket_type="counter")
    remaining = remaining.loc[~remaining["selection"].isin(counter["selection"])]
    remaining["longshot_score"] = remaining["probability"] * (
        1.0
        + 0.14 * (remaining["max_rank"] - 3).clip(lower=0)
        + 0.05 * (remaining["rank_sum"] - 6).clip(lower=0)
    )
    longshot = remaining.sort_values(
        ["longshot_score", "probability"], ascending=False
    ).head(caps.longshot).assign(ticket_type="longshot")
    return pd.concat([main, counter, longshot], ignore_index=True)


def generate_wake_tickets(runners: pd.DataFrame, blend: float) -> pd.DataFrame:
    candidates = _role_candidates(runners, blend)
    output = []
    for bet_type, frame in candidates.items():
        picked = _pick_groups(frame, bet_type)
        picked.insert(0, "bet_type", bet_type)
        output.append(picked)
    tickets = pd.concat(output, ignore_index=True)
    tickets.insert(0, "race_date", pd.to_datetime(runners["race_date"].iloc[0]))
    tickets.insert(0, "race_id", str(runners["race_id"].iloc[0]))
    return tickets


def generate_popularity_tickets(runners: pd.DataFrame) -> pd.DataFrame:
    popular = runners.copy()
    rank = pd.to_numeric(popular["popularity"], errors="coerce")
    fallback = rank.max(skipna=True) + 1 if rank.notna().any() else len(rank)
    weights = 1.0 / rank.fillna(fallback).clip(lower=1.0)
    popular["win_probability"] = weights / weights.sum()
    return generate_all_bet_tickets(popular)


def _winning_sequences(group: pd.DataFrame) -> list[tuple[int, int, int]]:
    placed = group.loc[group["finish_position"].notna() & (group["finish_position"] > 0)].copy()
    if len(placed) < 3:
        return []
    ordered_ranks = sorted(placed["finish_position"].astype(int).tolist())
    cutoff = ordered_ranks[2]
    pool = placed.loc[placed["finish_position"] <= cutoff]
    must_include = set(pool.loc[pool["finish_position"] < cutoff, "horse_number"].astype(int))
    valid = []
    for rows in itertools.permutations(pool.to_dict("records"), 3):
        horses = tuple(int(row["horse_number"]) for row in rows)
        ranks = tuple(int(row["finish_position"]) for row in rows)
        if not must_include.issubset(horses):
            continue
        if ranks[0] <= ranks[1] <= ranks[2]:
            valid.append(horses)
    return sorted(set(valid))


def build_outcomes(races: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, set[str]]]:
    rows = []
    eligible = {bet_type: set() for bet_type in BET_CAPS}
    for race_id, group in races.groupby("race_id", observed=True):
        race_id = str(race_id)
        starters = group.loc[group["finish_position"].notna() & (group["finish_position"] > 0)]
        field_size = len(starters)
        sequences = _winning_sequences(group)
        if not sequences:
            continue
        first_horses = {sequence[0] for sequence in sequences}
        first_two = {(sequence[0], sequence[1]) for sequence in sequences}
        first_three = set(sequences)
        horse_to_gate = dict(zip(group["horse_number"].astype(int), group["gate"].astype(int)))

        winning: dict[str, set[tuple[int, ...]]] = {
            "win": {(horse,) for horse in first_horses},
            "quinella": {tuple(sorted(pair)) for pair in first_two},
            "exacta": first_two,
            "trio": {tuple(sorted(sequence)) for sequence in first_three},
            "trifecta": first_three,
            "wide": {
                tuple(sorted(pair))
                for sequence in first_three
                for pair in itertools.combinations(sequence, 2)
            },
            "bracket_quinella": {
                tuple(sorted((horse_to_gate[a], horse_to_gate[b]))) for a, b in first_two
            },
            "place": set(),
        }

        place_count = 3 if field_size >= 8 else 2 if field_size >= 5 else 0
        if place_count:
            finish_order = sorted(starters["finish_position"].astype(int).tolist())
            place_cutoff = finish_order[place_count - 1]
            winning["place"] = {
                (int(horse),)
                for horse in starters.loc[
                    starters["finish_position"] <= place_cutoff, "horse_number"
                ]
            }

        minimum = {
            "win": 2, "place": 5, "bracket_quinella": 9, "quinella": 3,
            "wide": 4, "exacta": 3, "trio": 4, "trifecta": 4,
        }
        for bet_type, selections in winning.items():
            if field_size < minimum[bet_type] or not selections:
                continue
            eligible[bet_type].add(race_id)
            for selection in selections:
                rows.append({"race_id": race_id, "bet_type": bet_type, "selection": selection})
    return pd.DataFrame(rows), eligible


def _metrics(tickets: pd.DataFrame, outcomes: pd.DataFrame, eligible: set[str]) -> dict[str, object]:
    selected = tickets.loc[tickets["race_id"].isin(eligible)].copy()
    race_ids = sorted(set(selected["race_id"]))
    if not race_ids:
        return {"races": 0, "average_tickets_per_race": 0.0, "race_hits": 0,
                "race_hit_rate": 0.0, "winning_tickets": 0, "ticket_hit_rate": 0.0}
    checked = selected.merge(
        outcomes.assign(hit=True), on=["race_id", "bet_type", "selection"], how="left"
    )
    checked["hit"] = checked["hit"].eq(True)
    per_race = checked.groupby("race_id", observed=True)["hit"].any().reindex(race_ids, fill_value=False)
    return {
        "races": len(race_ids),
        "average_tickets_per_race": float(len(selected) / len(race_ids)),
        "race_hits": int(per_race.sum()),
        "race_hit_rate": float(per_race.mean()),
        "winning_tickets": int(checked["hit"].sum()),
        "ticket_hit_rate": float(checked["hit"].mean()),
    }


def _generate_many(runners: pd.DataFrame, method: str, blend: float | None = None) -> pd.DataFrame:
    frames = []
    for _, group in runners.groupby("race_id", observed=True, sort=False):
        clean = group.dropna(subset=["horse_number", "gate", "win_probability"])
        if len(clean) < 4:
            continue
        if method == "current":
            frame = generate_all_bet_tickets(clean)
        elif method == "popularity":
            frame = generate_popularity_tickets(clean)
        elif method == "wake":
            frame = generate_wake_tickets(clean, float(blend))
        else:
            raise ValueError(method)
        frames.append(frame)
    return pd.concat(frames, ignore_index=True)


def _prepare_runners(predictions: pd.DataFrame, races: pd.DataFrame) -> pd.DataFrame:
    history = add_point_in_time_features(races)
    columns = [
        "race_id", "horse_id", "horse_number", "gate", "popularity",
        "horse_win_rate", "horse_top3_rate", "jockey_win_rate", "jockey_top3_rate",
        "trainer_win_rate", "trainer_top3_rate", "horse_surface_top3_rate",
        "horse_distance_top3_rate", "horse_course_top3_rate",
        "horse_recent5_win_rate", "horse_recent5_top3_rate", "horse_recent5_avg_finish",
    ]
    return predictions.merge(
        history[columns], on=["race_id", "horse_id"], how="left", validate="one_to_one"
    )


def _period_metrics(
    tickets: pd.DataFrame,
    outcomes: pd.DataFrame,
    eligible: dict[str, set[str]],
) -> dict[str, dict[str, object]]:
    report = {}
    for bet_type in BET_CAPS:
        bet = tickets.loc[tickets["bet_type"] == bet_type]
        report[bet_type] = {
            group: _metrics(bet.loc[bet["ticket_type"] == group], outcomes, eligible[bet_type])
            for group in GROUPS
        }
        report[bet_type]["combined"] = _metrics(bet, outcomes, eligible[bet_type])
    return report


def evaluate(predictions_path: Path, races_path: Path, output_dir: Path) -> dict[str, object]:
    predictions = pd.read_parquet(predictions_path)
    races = pd.read_parquet(races_path)
    for frame in (predictions, races):
        frame["race_id"] = frame["race_id"].astype(str)
    predictions["race_date"] = pd.to_datetime(predictions["race_date"])
    races["race_date"] = pd.to_datetime(races["race_date"])
    races["finish_position"] = pd.to_numeric(races["finish_position"], errors="coerce")
    print("[comparison] building point-in-time WAKE signals", flush=True)
    runners = _prepare_runners(predictions, races)
    print(f"[comparison] prepared {runners['race_id'].nunique()} races", flush=True)
    outcomes, eligible = build_outcomes(races.loc[races["race_id"].isin(runners["race_id"])])

    validation_runners = runners.loc[runners["race_date"] < "2026-01-01"]
    validation_ids = set(validation_runners["race_id"])
    validation_outcomes = outcomes.loc[outcomes["race_id"].isin(validation_ids)]
    validation_eligible = {
        bet: ids & validation_ids for bet, ids in eligible.items()
    }

    ordered_validation_ids = sorted(validation_ids)
    if len(ordered_validation_ids) > 900:
        positions = np.linspace(0, len(ordered_validation_ids) - 1, 900, dtype=int)
        tuning_ids = {ordered_validation_ids[position] for position in positions}
    else:
        tuning_ids = validation_ids
    tuning_runners = validation_runners.loc[validation_runners["race_id"].isin(tuning_ids)]
    tuning_outcomes = validation_outcomes.loc[validation_outcomes["race_id"].isin(tuning_ids)]
    tuning_eligible = {bet: ids & tuning_ids for bet, ids in validation_eligible.items()}
    tuning: list[dict[str, object]] = []
    for blend in BLEND_CANDIDATES:
        print(f"[comparison] validation tuning blend={blend:.2f}", flush=True)
        generated = _generate_many(tuning_runners, "wake", blend)
        scores = _period_metrics(generated, tuning_outcomes, tuning_eligible)
        main_mean = float(np.mean([scores[bet]["main"]["race_hit_rate"] for bet in BET_CAPS]))
        combined_mean = float(np.mean([scores[bet]["combined"]["race_hit_rate"] for bet in BET_CAPS]))
        tuning.append({
            "blend": blend, "main_mean_hit_rate": main_mean,
            "combined_mean_hit_rate": combined_mean,
            "by_bet_type": scores,
        })

    selected_blend = max(
        tuning,
        key=lambda row: (row["main_mean_hit_rate"], row["combined_mean_hit_rate"], -row["blend"]),
    )["blend"]
    selected_blends = {bet_type: selected_blend for bet_type in BET_CAPS}
    print(f"[comparison] generating selected WAKE blend={selected_blend:.2f}", flush=True)
    wake_tickets = _generate_many(runners, "wake", selected_blend)
    strategy_tickets = {
        "wake": wake_tickets,
    }
    print("[comparison] generating popularity baseline", flush=True)
    strategy_tickets["popularity"] = _generate_many(runners, "popularity")
    print("[comparison] generating current baseline", flush=True)
    strategy_tickets["current"] = _generate_many(runners, "current")

    periods = {
        "validation": set(runners.loc[runners["race_date"] < "2026-01-01", "race_id"]),
        "test_2026": set(runners.loc[runners["race_date"] >= "2026-01-01", "race_id"]),
    }
    report: dict[str, object] = {
        "description": "WAKE-derived role scoring vs popularity order vs current generator",
        "caps": {bet: caps.__dict__ for bet, caps in BET_CAPS.items()},
        "selected_wake_blends": selected_blends,
        "wake_tuning_validation_only": {
            "races": len(tuning_ids), "candidates": tuning,
        },
        "periods": {},
    }
    summary_rows = []
    for period_name, race_ids in periods.items():
        period_outcomes = outcomes.loc[outcomes["race_id"].isin(race_ids)]
        period_eligible = {bet: ids & race_ids for bet, ids in eligible.items()}
        report["periods"][period_name] = {}
        for method, tickets in strategy_tickets.items():
            period_tickets = tickets.loc[tickets["race_id"].isin(race_ids)]
            metrics = _period_metrics(period_tickets, period_outcomes, period_eligible)
            report["periods"][period_name][method] = metrics
            for bet_type, groups in metrics.items():
                for group, row in groups.items():
                    summary_rows.append({
                        "period": period_name, "method": method, "bet_type": bet_type,
                        "ticket_type": group, **row,
                    })

    output_dir.mkdir(parents=True, exist_ok=True)
    for method, tickets in strategy_tickets.items():
        tickets.assign(method=method).to_parquet(output_dir / f"tickets-{method}.parquet", index=False)
    pd.DataFrame(summary_rows).to_csv(output_dir / "comparison.csv", index=False)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA全8券種でWAKE移植・人気順・従来方式を比較")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--races", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = evaluate(args.predictions, args.races, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
