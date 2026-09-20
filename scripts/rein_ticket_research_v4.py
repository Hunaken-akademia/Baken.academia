"""All-bet ticket research with role-specific, time-safe REIN features.

Models are trained through 2024. Strategy selection uses 2025 and the frozen
choice is audited on 2026. Ticket caps are identical to the current generator.
This is research only and does not modify the deployed web application.
"""
from __future__ import annotations

import itertools
import json
import multiprocessing as mp
import os
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rein_research import prepare
from rein_research_v3 import add_v3_features

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from baken_academia.all_bet_hit_rate import BET_CAPS
from baken_academia.bet_strategy_comparison import (
    GROUPS,
    _metrics,
    build_outcomes,
)
from baken_academia.features import build_feature_frame


OUT = Path("reports/rein-ticket-research-v4")
BET_TYPES = tuple(BET_CAPS)
MIXES = {
    "current": (1.00, 0.00, 0.00),
    "rein_role": (0.00, 0.00, 1.00),
    "current75_role25": (0.75, 0.00, 0.25),
    "current50_role50": (0.50, 0.00, 0.50),
    "market70_role30": (0.00, 0.70, 0.30),
    "market50_current25_role25": (0.25, 0.50, 0.25),
    "market50_role50": (0.00, 0.50, 0.50),
}
_WORKER_CONTEXT: dict[str, object] = {}


def normalize(values: pd.Series) -> np.ndarray:
    a = np.clip(pd.to_numeric(values, errors="coerce").fillna(0).to_numpy(float), 1e-9, None)
    return a / a.sum()


def role_probabilities(group: pd.DataFrame, mix: tuple[float, float, float]) -> pd.DataFrame:
    current_weight, market_weight, role_weight = mix
    current = normalize(group["win_probability"])
    popularity = pd.to_numeric(group["popularity"], errors="coerce")
    fallback = popularity.max(skipna=True) + 1 if popularity.notna().any() else len(group) + 1
    market = normalize(1 / popularity.fillna(fallback).clip(lower=1))
    outputs = {"horse_number": group["horse_number"].astype(int).to_numpy(),
               "gate": group["gate"].astype(int).to_numpy()}
    for role in ("first", "second", "third"):
        learned = normalize(group[f"v4_{role}_probability"])
        p = current_weight * current + market_weight * market + role_weight * learned
        outputs[role] = p / p.sum()
    return pd.DataFrame(outputs)


def aggregate(records: list[tuple[tuple[int, ...], float]]) -> pd.DataFrame:
    values: dict[tuple[int, ...], float] = {}
    for selection, probability in records:
        values[selection] = values.get(selection, 0.0) + float(probability)
    return pd.DataFrame({"selection": list(values), "probability": list(values.values())})


def candidates(group: pd.DataFrame, mix: tuple[float, float, float]) -> dict[str, pd.DataFrame]:
    roles = role_probabilities(group, mix)
    # Keep the union of the strongest role candidates, matching the prior WAKE
    # research design. Nine runners provide 504 ordered triples for a 30-point cap.
    support = roles[["first", "second", "third"]].max(axis=1)
    if len(roles) > 9:
        roles = roles.loc[support.nlargest(9).index].copy()
        for role in ("first", "second", "third"):
            roles[role] /= roles[role].sum()
    rows = roles.to_dict("records")
    singles = {
        "win": aggregate([((int(a["horse_number"]),), a["first"]) for a in rows]),
        "place": aggregate([((int(a["horse_number"]),), a["first"] + a["second"] + a["third"]) for a in rows]),
    }
    pairs = []
    for a, b in itertools.permutations(rows, 2):
        p = a["first"] * b["second"] / max(1 - a["second"], 1e-12)
        pairs.append((a, b, p))
    triples = []
    for a, b, c in itertools.permutations(rows, 3):
        p = (a["first"] * b["second"] / max(1 - a["second"], 1e-12)
             * c["third"] / max(1 - a["third"] - b["third"], 1e-12))
        triples.append((a, b, c, p))
    frames = dict(singles)
    frames["exacta"] = aggregate([((int(a["horse_number"]), int(b["horse_number"])), p) for a, b, p in pairs])
    frames["quinella"] = aggregate([(tuple(sorted((int(a["horse_number"]), int(b["horse_number"])))), p) for a, b, p in pairs])
    frames["bracket_quinella"] = aggregate([(tuple(sorted((int(a["gate"]), int(b["gate"])))), p) for a, b, p in pairs])
    frames["trifecta"] = aggregate([((int(a["horse_number"]), int(b["horse_number"]), int(c["horse_number"])), p) for a, b, c, p in triples])
    frames["trio"] = aggregate([(tuple(sorted((int(a["horse_number"]), int(b["horse_number"]), int(c["horse_number"])))), p) for a, b, c, p in triples])
    frames["wide"] = aggregate([
        (tuple(sorted((int(a["horse_number"]), int(b["horse_number"])))), p)
        for a, b, c, p in triples for a, b in ((a, b), (a, c), (b, c))
    ])
    return frames


def generate_race(
    group: pd.DataFrame,
    mix: tuple[float, float, float],
    caps: dict | None = None,
) -> pd.DataFrame:
    caps = caps or BET_CAPS
    outputs = []
    for bet_type, frame in candidates(group, mix).items():
        remaining = frame.sort_values("probability", ascending=False).copy()
        parts = []
        bet_caps = caps[bet_type]
        counts = bet_caps.__dict__.values() if hasattr(bet_caps, "__dict__") else bet_caps.values()
        for ticket_type, count in zip(GROUPS, counts):
            picked = remaining.head(count).assign(ticket_type=ticket_type)
            parts.append(picked)
            remaining = remaining.loc[~remaining["selection"].isin(picked["selection"])]
        picked = pd.concat(parts, ignore_index=True)
        picked.insert(0, "bet_type", bet_type)
        outputs.append(picked)
    tickets = pd.concat(outputs, ignore_index=True)
    tickets.insert(0, "race_date", pd.to_datetime(group["race_date"].iloc[0]))
    tickets.insert(0, "race_id", str(group["race_id"].iloc[0]))
    return tickets


def generate_all(
    runners: pd.DataFrame,
    mix: tuple[float, float, float],
    caps: dict | None = None,
) -> pd.DataFrame:
    frames = []
    total = runners["race_id"].nunique()
    for index, (_, group) in enumerate(runners.groupby("race_id", observed=True, sort=False), 1):
        clean = group.dropna(subset=["horse_number", "gate", "win_probability"])
        if len(clean) >= 4:
            frames.append(generate_race(clean, mix, caps))
        if index % 500 == 0:
            print(f"[tickets] {index}/{total}", flush=True)
    return pd.concat(frames, ignore_index=True)


def role_topk_metrics(runners: pd.DataFrame, raw: pd.DataFrame, race_ids: set[str]) -> dict:
    """Measure whether each role model's Top-K contains the actual finisher."""
    finishes = raw.loc[
        raw["race_id"].isin(race_ids)
        & pd.to_numeric(raw["finish_position"], errors="coerce").isin([1, 2, 3]),
        ["race_id", "horse_number", "finish_position"],
    ].copy()
    finishes["race_id"] = finishes["race_id"].astype(str)
    finishes["horse_number"] = pd.to_numeric(finishes["horse_number"], errors="coerce")
    finishes["finish_position"] = pd.to_numeric(finishes["finish_position"], errors="coerce")
    actual = {
        (race_id, position): set(group["horse_number"].dropna().astype(int))
        for (race_id, position), group in finishes.groupby(["race_id", "finish_position"], observed=True)
    }
    roles = (("first", 1), ("second", 2), ("third", 3))
    hits = {role: {k: [] for k in (3, 4, 5)} for role, _ in roles}
    simultaneous = {k: [] for k in (3, 4, 5)}
    eligible_races = 0
    for race_id, group in runners.loc[runners["race_id"].isin(race_ids)].groupby("race_id", observed=True):
        race_id = str(race_id)
        if not all(actual.get((race_id, position)) for _, position in roles):
            continue
        eligible_races += 1
        per_role = {}
        for role, position in roles:
            ranked = group.sort_values([f"v4_{role}_probability", "horse_number"], ascending=[False, True])
            numbers = ranked["horse_number"].dropna().astype(int).tolist()
            per_role[role] = {}
            for k in (3, 4, 5):
                hit = bool(set(numbers[:k]) & actual[(race_id, position)])
                hits[role][k].append(hit)
                per_role[role][k] = hit
        for k in (3, 4, 5):
            simultaneous[k].append(all(per_role[role][k] for role, _ in roles))
    return {
        "races": eligible_races,
        "by_role": {
            role: {
                f"top{k}": {"hits": int(sum(values)), "hit_rate": float(np.mean(values))}
                for k, values in role_hits.items()
            }
            for role, role_hits in hits.items()
        },
        "all_three_roles": {
            f"top{k}": {"hits": int(sum(values)), "hit_rate": float(np.mean(values))}
            for k, values in simultaneous.items()
        },
    }


def run_v5_audit(
    runners: pd.DataFrame,
    raw: pd.DataFrame,
    outcomes: pd.DataFrame,
    eligible: dict[str, set[str]],
    ids_2026: set[str],
) -> None:
    balanced_caps = {
        bet_type: {
            "main": caps.main,
            "counter": caps.counter,
            "longshot": caps.counter,
        }
        for bet_type, caps in BET_CAPS.items()
    }
    reports = {}
    for name, cap_config in (("current", BET_CAPS), ("balanced_longshot", balanced_caps)):
        print(f"[v5 audit] {name}", flush=True)
        tickets = generate_all(runners.loc[runners["race_id"].isin(ids_2026)], MIXES["market70_role30"], cap_config)
        reports[name] = period_metrics(tickets, outcomes, eligible, ids_2026)
    report = {
        "scope": "2026 audit; role models train through 2024; market70_role30 ticket ranking.",
        "races": len(ids_2026),
        "caps": {
            "current": {bet: caps.__dict__ for bet, caps in BET_CAPS.items()},
            "balanced_longshot": balanced_caps,
        },
        "ticket_metrics": reports,
        "role_topk": role_topk_metrics(runners, raw, ids_2026),
    }
    out = Path("reports/rein-ticket-audit-v5")
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("REIN_TICKET_AUDIT_V5_JSON_BEGIN", flush=True)
    print(json.dumps(report, ensure_ascii=False), flush=True)
    print("REIN_TICKET_AUDIT_V5_JSON_END", flush=True)


def period_metrics(tickets: pd.DataFrame, outcomes: pd.DataFrame,
                   eligible: dict[str, set[str]], race_ids: set[str]) -> dict:
    result = {}
    period_outcomes = outcomes.loc[outcomes["race_id"].isin(race_ids)]
    for bet_type in BET_TYPES:
        bet = tickets.loc[(tickets["bet_type"] == bet_type) & tickets["race_id"].isin(race_ids)]
        result[bet_type] = {
            group: _metrics(bet.loc[bet["ticket_type"] == group], period_outcomes,
                            eligible[bet_type] & race_ids)
            for group in GROUPS
        }
        result[bet_type]["combined"] = _metrics(
            bet, period_outcomes, eligible[bet_type] & race_ids
        )
    return result


def evaluate_mix(item: tuple[str, tuple[float, float, float]]) -> tuple[str, dict, dict]:
    name, mix = item
    print(f"[strategy] {name}", flush=True)
    tickets = generate_all(_WORKER_CONTEXT["runners"], mix)
    selection = period_metrics(
        tickets, _WORKER_CONTEXT["outcomes"], _WORKER_CONTEXT["eligible"],
        _WORKER_CONTEXT["ids_2025"],
    )
    audit = period_metrics(
        tickets, _WORKER_CONTEXT["outcomes"], _WORKER_CONTEXT["eligible"],
        _WORKER_CONTEXT["ids_2026"],
    )
    return name, selection, audit


def main() -> None:
    history_path = Path(os.environ.get("REIN_HISTORY_PATH", "data/raw/history.parquet"))
    raw = pd.read_parquet(history_path)
    raw["race_id"] = raw["race_id"].astype(str)
    print("[features] point-in-time history", flush=True)
    x, added = add_v3_features(prepare(raw))
    base, _, _ = build_feature_frame(x)
    inherited = [c for c in x if c.startswith(("prior_", "recent3_")) or "_recent90_" in c]
    inherited += ["expected_front_count", "relative_early"]
    feature_names = list(dict.fromkeys(inherited + added))
    frame = pd.concat([base, x[feature_names]], axis=1)
    flat = x["surface"].isin(["芝", "ダート"])
    train = x["race_date"].lt("2025-01-01") & flat
    model_info = {}
    model_dir = Path(os.environ.get("REIN_MODEL_DIR", "artifacts/rein-role-model-v4"))
    model_dir.mkdir(parents=True, exist_ok=True)
    for role, position in (("first", 1), ("second", 2), ("third", 3)):
        y = pd.to_numeric(x["finish_position"], errors="coerce").eq(position)
        print(f"[model] {role}", flush=True)
        model = lgb.LGBMClassifier(
            n_estimators=650, learning_rate=.03, num_leaves=15,
            min_child_samples=250, feature_fraction=.8, bagging_fraction=.9,
            bagging_freq=1, reg_lambda=8, n_jobs=4, verbosity=-1,
            random_state=900 + position,
        )
        model.fit(frame.loc[train], y.loc[train])
        x[f"v4_{role}_probability"] = model.predict_proba(frame)[:, 1]
        model_info[role] = {"iterations": 650}
        model.booster_.save_model(str(model_dir / f"{role}.txt"))

    (model_dir / "schema.json").write_text(json.dumps({
        "version": "rein-role-v4",
        "base_features": list(base.columns),
        "advanced_features": feature_names,
        "feature_order": list(frame.columns),
        "trained_through": "2024-12-31",
    }, ensure_ascii=False, indent=2))
    if os.environ.get("REIN_TRAIN_ONLY") == "1":
        print(f"[model] exported to {model_dir}", flush=True)
        return

    predictions = pd.read_parquet(".model/test_predictions.parquet")
    predictions["race_id"] = predictions["race_id"].astype(str)
    columns = ["race_id", "horse_id", "horse_number", "gate", "popularity",
               "v4_first_probability", "v4_second_probability", "v4_third_probability"]
    runners = predictions.merge(x[columns], on=["race_id", "horse_id"], how="left", validate="one_to_one")
    runners = runners.loc[runners["race_id"].isin(set(x.loc[flat, "race_id"]))].copy()
    outcomes, eligible = build_outcomes(raw.loc[raw["race_id"].isin(runners["race_id"])])
    ids_2025 = set(runners.loc[runners["race_date"].between("2025-03-01", "2025-12-31"), "race_id"])
    ids_2026 = set(runners.loc[runners["race_date"].ge("2026-01-01"), "race_id"])

    if os.environ.get("REIN_AUDIT_V5_ONLY") == "1":
        run_v5_audit(runners, raw, outcomes, eligible, ids_2026)
        return

    tuning = {}
    audits = {}
    _WORKER_CONTEXT.update({
        "runners": runners, "outcomes": outcomes, "eligible": eligible,
        "ids_2025": ids_2025, "ids_2026": ids_2026,
    })
    # Research is CPU-only and makes no JRA requests. Four workers keep it
    # separate from the ongoing four-way odds collection.
    with mp.get_context("fork").Pool(processes=4) as pool:
        for name, selection_metrics, audit_metrics in pool.map(evaluate_mix, MIXES.items()):
            tuning[name] = selection_metrics
            audits[name] = audit_metrics

    # Choose independently for each bet type. The current strategy wins ties,
    # which prevents needless complexity for negligible validation differences.
    selected = {}
    for bet_type in BET_TYPES:
        best = max(
            MIXES,
            key=lambda name: (
                tuning[name][bet_type]["combined"]["race_hit_rate"],
                tuning[name][bet_type]["main"]["race_hit_rate"],
                name == "current",
            ),
        )
        selected[bet_type] = best

    report = {
        "scope": "Research only; models train through 2024, strategy selection uses 2025, audit uses 2026.",
        "caps": {bet: BET_CAPS[bet].__dict__ for bet in BET_TYPES},
        "model_features": feature_names,
        "models": model_info,
        "mixes": {name: {"current": v[0], "market": v[1], "role_model": v[2]} for name, v in MIXES.items()},
        "selected_by_bet_type": selected,
        "periods": {"selection_2025": {}, "audit_2026": {}},
    }
    for name in MIXES:
        report["periods"]["selection_2025"][name] = tuning[name]
        report["periods"]["audit_2026"][name] = audits[name]

    report["comparison"] = {}
    for bet_type, selected_name in selected.items():
        current = report["periods"]["audit_2026"]["current"][bet_type]
        improved = report["periods"]["audit_2026"][selected_name][bet_type]
        comparison = {
            group: {
                "current_hit_rate": current[group]["race_hit_rate"],
                "candidate_hit_rate": improved[group]["race_hit_rate"],
                "change_pp": 100 * (improved[group]["race_hit_rate"] - current[group]["race_hit_rate"]),
                "points": improved[group]["average_tickets_per_race"],
            }
            for group in (*GROUPS, "combined")
        }
        comparison["selected"] = selected_name
        report["comparison"][bet_type] = comparison
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"selected": selected, "comparison": report["comparison"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
