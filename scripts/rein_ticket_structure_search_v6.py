"""Search lower-point REIN wheel/formation ticket structures.

Role models train through 2024. Plans are selected on 2025 and audited on
2026. A separate retrospective-safe result requires no combined hit loss in
both years; it is never presented as an untouched holdout result.
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rein_research import prepare
from rein_research_v3 import add_v3_features
from rein_ticket_research_v4 import BET_TYPES, MIXES, candidates, role_probabilities

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from baken_academia.bet_strategy_comparison import build_outcomes
from baken_academia.features import build_feature_frame


OUT = Path("reports/rein-ticket-structure-v6")
GROUPS = ("main", "counter", "longshot")
BASE_CAPS = {
    "win": (1, 1, 1), "place": (1, 1, 1),
    "bracket_quinella": (3, 4, 4), "quinella": (5, 6, 6),
    "wide": (4, 5, 5), "exacta": (8, 10, 10),
    "trio": (10, 12, 12), "trifecta": (15, 22, 22),
}
CAP_GRIDS = {
    "win": [(1, 1, 1)],
    "place": [(1, 1, 1)],
    "bracket_quinella": [(2, 2, 2), (2, 3, 3), (3, 3, 3), (3, 4, 3), (3, 4, 4)],
    "quinella": [(3, 3, 3), (3, 4, 4), (4, 5, 5), (5, 5, 5), (5, 6, 5), (5, 6, 6)],
    "wide": [(2, 3, 3), (3, 3, 3), (3, 4, 4), (4, 4, 4), (4, 5, 4), (4, 5, 5)],
    "exacta": [(4, 5, 5), (5, 6, 6), (6, 8, 8), (8, 8, 8), (8, 10, 8), (8, 10, 9), (8, 10, 10)],
    "trio": [(5, 6, 6), (6, 8, 8), (8, 10, 10), (10, 10, 10), (10, 12, 10), (10, 12, 11), (10, 12, 12)],
    "trifecta": [(6, 8, 8), (8, 12, 12), (10, 15, 15), (12, 18, 18), (15, 20, 20),
                 (15, 22, 20), (15, 22, 21), (15, 22, 22)],
}


def unique(values):
    return list(dict.fromkeys(values))


def ticket_rankings(group: pd.DataFrame) -> dict[str, list[int]]:
    roles = role_probabilities(group, MIXES["market70_role30"])
    if len(roles) > 9:
        support = roles[["first", "second", "third"]].max(axis=1)
        roles = roles.loc[support.nlargest(9).index].copy()
    return {
        role: roles.sort_values([role, "horse_number"], ascending=[False, True])["horse_number"].astype(int).tolist()
        for role in ("first", "second", "third")
    } | {
        "support": roles.assign(support=roles[["first", "second", "third"]].max(axis=1))
        .sort_values(["support", "horse_number"], ascending=[False, True])["horse_number"].astype(int).tolist(),
        "horse_to_gate": dict(zip(roles["horse_number"].astype(int), roles["gate"].astype(int))),
    }


def strategies(bet_type: str) -> list[str]:
    if bet_type in ("win", "place"):
        return ["flat"]
    if bet_type in ("bracket_quinella", "quinella", "wide"):
        return ["flat", "axis_first1", "axis_support1", "axes_first2", "axes_support2"]
    if bet_type == "exacta":
        return ["flat", "head_first1", "heads_first2", "form_1_3", "form_1_5", "form_2_3", "form_2_5"]
    if bet_type == "trio":
        return ["flat", "axis_first1", "axis_support1", "axes_first2", "axes_support2", "two_role_axes"]
    return [
        "flat", "head_first1", "heads_first2", "form_1_3_6", "form_1_4_8",
        "form_2_3_6", "form_2_4_8", "two_role_axes_8",
    ]


def ordered_selections(
    frame: pd.DataFrame, bet_type: str, strategy: str, ranks: dict[str, list[int]]
) -> list[tuple[int, ...]]:
    ordered = frame.sort_values("probability", ascending=False)
    if strategy == "flat":
        return ordered["selection"].tolist()

    first, second, third, support = (ranks[k] for k in ("first", "second", "third", "support"))
    horse_to_gate = ranks["horse_to_gate"]
    if bet_type == "bracket_quinella":
        first = unique([horse_to_gate[h] for h in first])
        support = unique([horse_to_gate[h] for h in support])

    def keep(selection: tuple[int, ...]) -> bool:
        values = set(selection)
        if bet_type in ("bracket_quinella", "quinella", "wide"):
            if strategy == "axis_first1": return first[0] in values
            if strategy == "axis_support1": return support[0] in values
            if strategy == "axes_first2": return bool(values & set(first[:2]))
            if strategy == "axes_support2": return bool(values & set(support[:2]))
        if bet_type == "exacta":
            if strategy == "head_first1": return selection[0] == first[0]
            if strategy == "heads_first2": return selection[0] in first[:2]
            if strategy.startswith("form_"):
                _, f, s = strategy.split("_")
                return selection[0] in first[:int(f)] and selection[1] in second[:int(s)]
        if bet_type == "trio":
            if strategy == "axis_first1": return first[0] in values
            if strategy == "axis_support1": return support[0] in values
            if strategy == "axes_first2": return bool(values & set(first[:2]))
            if strategy == "axes_support2": return bool(values & set(support[:2]))
            if strategy == "two_role_axes":
                second_axis = next((h for h in second if h != first[0]), None)
                return second_axis is not None and {first[0], second_axis}.issubset(values)
        if bet_type == "trifecta":
            if strategy == "head_first1": return selection[0] == first[0]
            if strategy == "heads_first2": return selection[0] in first[:2]
            if strategy.startswith("form_"):
                _, f, s, t = strategy.split("_")
                return (selection[0] in first[:int(f)] and selection[1] in second[:int(s)]
                        and selection[2] in third[:int(t)])
            if strategy == "two_role_axes_8":
                second_axis = next((h for h in second if h != first[0]), None)
                return (second_axis is not None and selection[0] == first[0]
                        and selection[1] == second_axis and selection[2] in third[:8])
        return False

    return [selection for selection in ordered["selection"] if keep(selection)]


def empty_stats() -> dict[str, float]:
    return {"races": 0, "tickets": 0, "main_hits": 0, "counter_hits": 0,
            "longshot_hits": 0, "combined_hits": 0}


def add_race(stats: dict[str, float], selections: list[tuple[int, ...]], winners: set, caps: tuple[int, int, int]) -> None:
    stats["races"] += 1
    offsets = (0, caps[0], caps[0] + caps[1], sum(caps))
    picked = selections[:offsets[-1]]
    stats["tickets"] += len(picked)
    for index, group in enumerate(GROUPS):
        tier = picked[offsets[index]:offsets[index + 1]]
        stats[f"{group}_hits"] += int(any(selection in winners for selection in tier))
    stats["combined_hits"] += int(any(selection in winners for selection in picked))


def finish(stats: dict[str, float]) -> dict:
    races = int(stats["races"])
    result = {"races": races, "average_tickets_per_race": stats["tickets"] / races}
    for group in (*GROUPS, "combined"):
        hits = int(stats[f"{group}_hits"])
        result[group] = {"race_hits": hits, "race_hit_rate": hits / races}
    return result


def race_result(selections: list[tuple[int, ...]], winners: set, caps: tuple[int, int, int]) -> dict:
    offsets = (0, caps[0], caps[0] + caps[1], sum(caps))
    picked = selections[:offsets[-1]]
    result = {"tickets": len(picked)}
    for index, group in enumerate(GROUPS):
        tier = picked[offsets[index]:offsets[index + 1]]
        result[f"{group}_hit"] = int(any(selection in winners for selection in tier))
    result["combined_hit"] = int(any(selection in winners for selection in picked))
    return result


def adaptive_metrics(rows: list[dict], reduced: tuple[int, int, int], score_name: str, threshold: float) -> dict:
    stats = empty_stats()
    for row in rows:
        use_reduced = row[score_name] >= threshold
        result = row["results"][reduced if use_reduced else row["baseline_caps"]]
        stats["races"] += 1
        stats["tickets"] += result["tickets"]
        for group in GROUPS:
            stats[f"{group}_hits"] += result[f"{group}_hit"]
        stats["combined_hits"] += result["combined_hit"]
    return finish(stats)


def adaptive_search(rows_2025: dict[str, list[dict]], rows_2026: dict[str, list[dict]],
                    fixed_metrics: dict[str, dict]) -> tuple[dict, dict]:
    selected, safe = {}, {}
    fractions = (.05, .10, .15, .20, .30, .40, .50, .60, .70, .80)
    for bet_type in BET_TYPES:
        baseline_key = key(bet_type, "flat", BASE_CAPS[bet_type])
        baseline_2025 = fixed_metrics["selection_2025"][baseline_key]
        baseline_2026 = fixed_metrics["audit_2026"][baseline_key]
        options = []
        for reduced in CAP_GRIDS[bet_type]:
            if reduced == BASE_CAPS[bet_type]:
                continue
            for score_name in ("coverage", "top_share", "gap"):
                values = np.array([row[score_name] for row in rows_2025[bet_type]], dtype=float)
                for fraction in fractions:
                    threshold = float(np.quantile(values, 1 - fraction))
                    metric_2025 = adaptive_metrics(rows_2025[bet_type], reduced, score_name, threshold)
                    metric_2026 = adaptive_metrics(rows_2026[bet_type], reduced, score_name, threshold)
                    options.append({
                        "reduced_caps": reduced, "score": score_name,
                        "selection_fraction": fraction, "threshold": threshold,
                        "selection_2025": metric_2025, "audit_2026": metric_2026,
                        "baseline_2025": baseline_2025, "baseline_2026": baseline_2026,
                    })
        qualified = [row for row in options
                     if row["selection_2025"]["combined"]["race_hits"] >= baseline_2025["combined"]["race_hits"]]
        both = [row for row in qualified
                if row["audit_2026"]["combined"]["race_hits"] >= baseline_2026["combined"]["race_hits"]]
        selected[bet_type] = min(qualified, key=lambda row: (
            row["selection_2025"]["average_tickets_per_race"],
            -row["selection_2025"]["combined"]["race_hits"],
        )) if qualified else None
        safe[bet_type] = min(both, key=lambda row: (
            row["selection_2025"]["average_tickets_per_race"] + row["audit_2026"]["average_tickets_per_race"],
            -row["selection_2025"]["combined"]["race_hits"] - row["audit_2026"]["combined"]["race_hits"],
        )) if both else None
    return selected, safe


def key(bet_type: str, strategy: str, caps: tuple[int, int, int]) -> str:
    return f"{bet_type}|{strategy}|{'-'.join(map(str, caps))}"


def parse_key(value: str) -> tuple[str, str, tuple[int, int, int]]:
    bet_type, strategy, caps = value.split("|")
    return bet_type, strategy, tuple(map(int, caps.split("-")))


def select_best(metrics: dict[str, dict], bet_type: str, baseline: dict, *, second_period: dict | None = None,
                second_baseline: dict | None = None) -> tuple[str, dict] | None:
    eligible = []
    for config, row in metrics.items():
        current_bet, _, _ = parse_key(config)
        if current_bet != bet_type or row["combined"]["race_hits"] < baseline["combined"]["race_hits"]:
            continue
        if second_period is not None and second_period[config]["combined"]["race_hits"] < second_baseline["combined"]["race_hits"]:
            continue
        eligible.append((config, row))
    if not eligible:
        return None
    return min(eligible, key=lambda item: (
        item[1]["average_tickets_per_race"]
        + (second_period[item[0]]["average_tickets_per_race"] if second_period else 0),
        -item[1]["combined"]["race_hits"],
    ))


def main() -> None:
    raw = pd.read_parquet(Path(os.environ.get("REIN_HISTORY_PATH", "data/raw/history.parquet")))
    raw["race_id"] = raw["race_id"].astype(str)
    print("[features]", flush=True)
    x, added = add_v3_features(prepare(raw))
    base, _, _ = build_feature_frame(x)
    inherited = [c for c in x if c.startswith(("prior_", "recent3_")) or "_recent90_" in c]
    inherited += ["expected_front_count", "relative_early"]
    feature_names = list(dict.fromkeys(inherited + added))
    model_frame = pd.concat([base, x[feature_names]], axis=1)
    flat = x["surface"].isin(["芝", "ダート"])
    train = x["race_date"].lt("2025-01-01") & flat
    for role, position in (("first", 1), ("second", 2), ("third", 3)):
        print(f"[model] {role}", flush=True)
        model = lgb.LGBMClassifier(
            n_estimators=650, learning_rate=.03, num_leaves=15, min_child_samples=250,
            feature_fraction=.8, bagging_fraction=.9, bagging_freq=1, reg_lambda=8,
            n_jobs=4, verbosity=-1, random_state=900 + position,
        )
        y = pd.to_numeric(x["finish_position"], errors="coerce").eq(position)
        model.fit(model_frame.loc[train], y.loc[train])
        x[f"v4_{role}_probability"] = model.predict_proba(model_frame)[:, 1]

    predictions = pd.read_parquet(".model/test_predictions.parquet")
    predictions["race_id"] = predictions["race_id"].astype(str)
    columns = ["race_id", "horse_id", "horse_number", "gate", "popularity",
               "v4_first_probability", "v4_second_probability", "v4_third_probability"]
    runners = predictions.merge(x[columns], on=["race_id", "horse_id"], how="left", validate="one_to_one")
    runners = runners.loc[runners["race_id"].isin(set(x.loc[flat, "race_id"]))].copy()
    outcomes, eligible = build_outcomes(raw.loc[raw["race_id"].isin(runners["race_id"])])
    outcome_map = {
        (race_id, bet_type): set(group["selection"])
        for (race_id, bet_type), group in outcomes.groupby(["race_id", "bet_type"], observed=True)
    }
    periods = {
        "selection_2025": set(runners.loc[runners["race_date"].between("2025-03-01", "2025-12-31"), "race_id"]),
        "audit_2026": set(runners.loc[runners["race_date"].ge("2026-01-01"), "race_id"]),
    }
    accumulators = {period: defaultdict(empty_stats) for period in periods}
    adaptive_rows = {period: {bet_type: [] for bet_type in BET_TYPES} for period in periods}
    total = runners["race_id"].nunique()
    for index, (race_id, group) in enumerate(runners.groupby("race_id", observed=True, sort=False), 1):
        clean = group.dropna(subset=["horse_number", "gate", "win_probability"])
        if len(clean) < 4:
            continue
        period = next((name for name, ids in periods.items() if race_id in ids), None)
        if period is None:
            continue
        frames = candidates(clean, MIXES["market70_role30"])
        ranks = ticket_rankings(clean)
        for bet_type in BET_TYPES:
            if race_id not in eligible[bet_type]:
                continue
            winners = outcome_map.get((race_id, bet_type), set())
            flat_frame = frames[bet_type].sort_values("probability", ascending=False)
            flat_selections = flat_frame["selection"].tolist()
            probabilities = flat_frame["probability"].to_numpy(float)
            baseline_total = sum(BASE_CAPS[bet_type])
            baseline_mass = float(probabilities[:baseline_total].sum()) or 1e-12
            second_probability = probabilities[1] if len(probabilities) > 1 else 0.0
            row = {
                "baseline_caps": BASE_CAPS[bet_type],
                "top_share": float(probabilities[0] / baseline_mass) if len(probabilities) else 0.0,
                "gap": float((probabilities[0] - second_probability) / max(probabilities[0], 1e-12)) if len(probabilities) else 0.0,
                "results": {},
            }
            for caps in CAP_GRIDS[bet_type]:
                reduced_mass = float(probabilities[:sum(caps)].sum())
                # Coverage is overwritten below per adaptive option; store each
                # cap-specific value in a companion mapping.
                row.setdefault("coverage_by_caps", {})[caps] = reduced_mass / baseline_mass
                row["results"][caps] = race_result(flat_selections, winners, caps)
            # The adaptive evaluator reads one scalar. Add cap-specific clones
            # so every reduced plan uses its own probability-mass coverage.
            for caps in CAP_GRIDS[bet_type]:
                clone = dict(row)
                clone["coverage"] = row["coverage_by_caps"][caps]
                clone["adaptive_caps"] = caps
                adaptive_rows[period][bet_type].append(clone)
            for strategy in strategies(bet_type):
                selections = ordered_selections(frames[bet_type], bet_type, strategy, ranks)
                for caps in CAP_GRIDS[bet_type]:
                    add_race(accumulators[period][key(bet_type, strategy, caps)], selections, winners, caps)
        if index % 500 == 0:
            print(f"[search] {index}/{total}", flush=True)

    metrics = {
        period: {config: finish(stats) for config, stats in values.items()}
        for period, values in accumulators.items()
    }
    # Keep only the clone matching each plan when adaptive_metrics evaluates it.
    # Grouping here avoids mixing coverage scores belonging to other caps.
    adaptive_grouped = {period: {bet_type: {} for bet_type in BET_TYPES} for period in periods}
    for period in periods:
        for bet_type in BET_TYPES:
            for row in adaptive_rows[period][bet_type]:
                adaptive_grouped[period][bet_type].setdefault(row["adaptive_caps"], []).append(row)

    # adaptive_search expects one row list per bet; execute per reduced cap by
    # temporarily presenting the matching list and retain the globally best.
    adaptive_selected_all = {bet_type: [] for bet_type in BET_TYPES}
    adaptive_safe_all = {bet_type: [] for bet_type in BET_TYPES}
    for bet_type in BET_TYPES:
        for reduced in CAP_GRIDS[bet_type]:
            if reduced == BASE_CAPS[bet_type]:
                continue
            rows25 = {name: (adaptive_grouped["selection_2025"][name].get(reduced, []) if name == bet_type else []) for name in BET_TYPES}
            rows26 = {name: (adaptive_grouped["audit_2026"][name].get(reduced, []) if name == bet_type else []) for name in BET_TYPES}
            # Inline this bet only; other empty lists are not evaluated.
            baseline_key = key(bet_type, "flat", BASE_CAPS[bet_type])
            b25, b26 = metrics["selection_2025"][baseline_key], metrics["audit_2026"][baseline_key]
            for score_name in ("coverage", "top_share", "gap"):
                values = np.array([row[score_name] for row in rows25[bet_type]], dtype=float)
                for fraction in (.05, .10, .15, .20, .30, .40, .50, .60, .70, .80):
                    threshold = float(np.quantile(values, 1 - fraction))
                    m25 = adaptive_metrics(rows25[bet_type], reduced, score_name, threshold)
                    m26 = adaptive_metrics(rows26[bet_type], reduced, score_name, threshold)
                    option = {"reduced_caps": reduced, "score": score_name, "selection_fraction": fraction,
                              "threshold": threshold, "selection_2025": m25, "audit_2026": m26,
                              "baseline_2025": b25, "baseline_2026": b26}
                    if m25["combined"]["race_hits"] >= b25["combined"]["race_hits"]:
                        adaptive_selected_all[bet_type].append(option)
                        if m26["combined"]["race_hits"] >= b26["combined"]["race_hits"]:
                            adaptive_safe_all[bet_type].append(option)

    adaptive_selected = {
        bet: (min(rows, key=lambda row: (row["selection_2025"]["average_tickets_per_race"],
                                         -row["selection_2025"]["combined"]["race_hits"])) if rows else None)
        for bet, rows in adaptive_selected_all.items()
    }
    adaptive_safe = {
        bet: (min(rows, key=lambda row: (row["selection_2025"]["average_tickets_per_race"]
                                         + row["audit_2026"]["average_tickets_per_race"],
                                         -row["selection_2025"]["combined"]["race_hits"]
                                         -row["audit_2026"]["combined"]["race_hits"])) if rows else None)
        for bet, rows in adaptive_safe_all.items()
    }

    report = {"scope": "Train <=2024; select 2025; audit 2026", "baseline_caps": BASE_CAPS,
              "periods": metrics, "selection_2025": {}, "retrospective_safe": {}}
    for bet_type in BET_TYPES:
        baseline_key = key(bet_type, "flat", BASE_CAPS[bet_type])
        baseline_2025 = metrics["selection_2025"][baseline_key]
        baseline_2026 = metrics["audit_2026"][baseline_key]
        selected = select_best(metrics["selection_2025"], bet_type, baseline_2025)
        safe = select_best(metrics["selection_2025"], bet_type, baseline_2025,
                           second_period=metrics["audit_2026"], second_baseline=baseline_2026)
        for target, choice in (("selection_2025", selected), ("retrospective_safe", safe)):
            if choice is None:
                report[target][bet_type] = None
                continue
            config, selection_row = choice
            _, strategy, caps = parse_key(config)
            report[target][bet_type] = {
                "strategy": strategy, "caps": caps,
                "selection_2025": selection_row,
                "audit_2026": metrics["audit_2026"][config],
                "baseline_2025": baseline_2025, "baseline_2026": baseline_2026,
            }
    report["adaptive_selection_2025"] = adaptive_selected
    report["adaptive_retrospective_safe"] = adaptive_safe
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("REIN_TICKET_STRUCTURE_V6_JSON_BEGIN", flush=True)
    print(json.dumps(report, ensure_ascii=False), flush=True)
    print("REIN_TICKET_STRUCTURE_V6_JSON_END", flush=True)


if __name__ == "__main__":
    main()
