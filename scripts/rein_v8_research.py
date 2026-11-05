"""REIN v8 research: race-shape scenario mixture and gated same-day track bias.

Research only. Nothing here changes the deployed model, tickets or web app.

Protocol (JRA flat races):
- Production-equivalent role models (rein-role-v4 settings) trained through 2024
  give the baseline: 70% popularity + 30% role probability, single Harville.
- Scenario of a finished race (front / neutral / closer) comes from where its
  top-3 finishers ran at the first corner; cut points use 2019-2021 only.
- A multinomial scenario model, trained through 2024, predicts the scenario
  from pre-race field shape (expected front runners, known styles, field size,
  distance, course, going, class) plus, depending on the variant, no day bias,
  an always-on shrunk day bias, or the gated day bias.
- Scenario-conditional role models (v4 features + realized scenario), trained
  through 2024, give p(role | s).  Each scenario tilts the baseline marginals
  by p(role | s) / p(role), and tickets use the mixture over scenarios.
- The bias variant is chosen on 2025 by summed ticket hit rate; 2026 is audit.
  Every difference against the baseline carries a day-cluster bootstrap 95%
  interval, and a bet type passes only when both years' lows are above zero.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))
from rein_v7_research import _per_race_hits, build_designs  # noqa: E402

from baken_academia.all_bet_hit_rate import BET_CAPS  # noqa: E402
from baken_academia.bet_strategy_comparison import GROUPS, build_outcomes  # noqa: E402
from baken_academia.market_stack import day_bootstrap, market_probability, normalize_within  # noqa: E402
from baken_academia.race_scenarios import (  # noqa: E402
    SCENARIOS, day_bias, label_scenarios, mixture_candidates, pick_tickets, race_shape,
)

OUT = Path(os.environ.get("REIN_V8_OUTPUT", "reports/rein-v8-research"))
ESTIMATORS = int(os.environ.get("REIN_V8_ESTIMATORS", "650"))
TRAIN_END = "2025-01-01"
POSITIONS = {"first": 1, "second": 2, "third": 3}
BIAS_VARIANTS = {"mix_nobias": None, "mix_bias_shrunk": "bias_shrunk", "mix_bias_gated": "bias_gated"}
BET_TYPES = tuple(BET_CAPS)
_CTX: dict[str, object] = {}


def lgb_model(position: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        n_estimators=ESTIMATORS, learning_rate=.03, num_leaves=15, min_child_samples=250,
        feature_fraction=.8, bagging_fraction=.9, bagging_freq=1, reg_lambda=8, n_jobs=4,
        verbosity=-1, random_state=900 + position,
    )


def race_table(x: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    shape = race_shape(x)
    shape["scenario"], cuts = label_scenarios(shape, "2021-12-31")
    bias = day_bias(shape, cuts["reference_mean"])
    races = shape.merge(bias, on="race_id", how="left")
    field = x.groupby("race_id", observed=True).agg(
        field_size=("race_id", "size"),
        front_pressure_share=("front_pressure_share", "first"),
        known_style_share=("known_style_share", "first"),
        expected_front_count=("expected_front_count", "first"),
        distance_m=("distance_m", "first"), going=("going", "first"),
        class_tier=("class_tier", "first"),
        mean_prior_early=("prior_early_pct", "mean"),
    ).reset_index()
    races = races.merge(field, on="race_id", how="left")
    races["race_date"] = pd.to_datetime(races["race_date"])
    return races, cuts


def scenario_probabilities(races: pd.DataFrame) -> tuple[dict[str, pd.DataFrame], dict]:
    numeric = ["field_size", "front_pressure_share", "known_style_share", "expected_front_count",
               "distance_m", "class_tier", "mean_prior_early"]
    categorical = ["racecourse", "surface", "going"]
    train = races["race_date"].lt(TRAIN_END) & races["scenario"].notna() & races["surface"].isin(["芝", "ダート"])
    output, quality = {}, {}
    for name, bias in BIAS_VARIANTS.items():
        cols = numeric + ([bias] if bias else [])
        frame = races[cols + categorical].copy()
        frame[cols] = frame[cols].apply(pd.to_numeric, errors="coerce").fillna(frame[cols].median(numeric_only=True))
        frame[categorical] = frame[categorical].fillna("missing").astype(str)
        model = make_pipeline(
            ColumnTransformer([("num", StandardScaler(), cols),
                               ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=50), categorical)]),
            LogisticRegression(C=0.5, max_iter=2000),
        )
        model.fit(frame.loc[train], races.loc[train, "scenario"])
        proba = pd.DataFrame(model.predict_proba(frame), columns=model.classes_, index=races.index)[list(SCENARIOS)]
        proba.insert(0, "race_id", races["race_id"].to_numpy())
        output[name] = proba
        quality[name] = {}
        prior = races.loc[train, "scenario"].value_counts(normalize=True)
        for year in (2025, 2026):
            rows = races["race_date"].dt.year.eq(year) & races["scenario"].notna()
            labels = races.loc[rows, "scenario"]
            picked = np.array([proba.loc[i, s] for i, s in labels.items()])
            base = labels.map(prior).to_numpy(float)
            quality[name][str(year)] = {"races": int(rows.sum()), "log_loss": float(-np.log(picked).mean()),
                                        "base_rate_log_loss": float(-np.log(base).mean())}
    gated = races["bias_gate_on"].eq(1) & races["scenario"].notna() & races["race_date"].ge(TRAIN_END)
    sign = np.sign(races.loc[gated, "bias_gated"])
    realized = races.loc[gated, "scenario"].map({"closer": 1, "neutral": 0, "front": -1})
    quality["gate"] = {"gate_on_share": float(races.loc[races["race_date"].ge(TRAIN_END), "bias_gate_on"].mean()),
                       "gate_on_races": int(gated.sum()),
                       "direction_match": float((sign == realized).mean()) if gated.any() else float("nan"),
                       "opposite": float((sign == -realized).mean()) if gated.any() else float("nan")}
    return output, quality


def role_models(x: pd.DataFrame, design: dict[str, pd.DataFrame], races: pd.DataFrame) -> pd.DataFrame:
    flat = x["surface"].isin(["芝", "ダート"])
    train = x["race_date"].lt(TRAIN_END) & flat
    target = x["race_date"].ge(TRAIN_END) & flat
    scenario = x[["race_id"]].merge(races[["race_id", "scenario"]], on="race_id", how="left")["scenario"].to_numpy()
    probs = pd.DataFrame(index=x.index[target])
    for role, frame in design.items():
        y = pd.to_numeric(x["finish_position"], errors="coerce").eq(POSITIONS[role])
        print(f"[model] production-equivalent {role}", flush=True)
        model = lgb_model(POSITIONS[role]).fit(frame.loc[train], y.loc[train])
        probs[f"v4_{role}"] = model.predict_proba(frame.loc[target])[:, 1]
        cond = frame.copy()
        cond["scenario_front"] = (scenario == "front").astype(float)
        cond["scenario_closer"] = (scenario == "closer").astype(float)
        labelled = train & pd.Series(pd.notna(scenario), index=x.index)
        print(f"[model] scenario-conditional {role}", flush=True)
        cmodel = lgb_model(POSITIONS[role]).fit(cond.loc[labelled], y.loc[labelled])
        for s in SCENARIOS:
            what_if = cond.loc[target].copy()
            what_if["scenario_front"] = float(s == "front")
            what_if["scenario_closer"] = float(s == "closer")
            probs[f"cond_{s}_{role}"] = cmodel.predict_proba(what_if)[:, 1]
    return probs


def evaluation_frame(x: pd.DataFrame, probs: pd.DataFrame) -> pd.DataFrame:
    columns = ["race_id", "race_date", "horse_number", "gate", "popularity", "finish_position"]
    e = pd.concat([x.loc[probs.index, columns], probs], axis=1).dropna(subset=["horse_number", "gate"])
    e["race_id"] = e["race_id"].astype(str)
    e = e.sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    e = e.loc[e.groupby("race_id")["race_id"].transform("size").ge(4)].reset_index(drop=True)
    e["period"] = np.where(e["race_date"].dt.year.eq(2025), "selection_2025", "audit_2026")
    market = market_probability(e["popularity"], e["race_id"])
    for role in POSITIONS:
        e[f"m_{role}"] = .7 * market + .3 * normalize_within(e[f"v4_{role}"], e["race_id"])
        for s in SCENARIOS:
            e[f"c_{s}_{role}"] = normalize_within(e[f"cond_{s}_{role}"], e["race_id"])
    return e


def _race_tickets(group: pd.DataFrame, weights: pd.DataFrame | None) -> pd.DataFrame:
    marginals = {r: group[f"m_{r}"].to_numpy(float) for r in POSITIONS}
    tilts, scenario_weights = None, {}
    if weights is not None:
        row = weights.loc[group["race_id"].iloc[0]]
        scenario_weights = {s: float(row[s]) for s in SCENARIOS}
        tilts = {}
        for role in POSITIONS:
            mixed = sum(scenario_weights[s] * group[f"c_{s}_{role}"].to_numpy(float) for s in SCENARIOS)
            for s in SCENARIOS:
                tilts.setdefault(s, {})[role] = group[f"c_{s}_{role}"].to_numpy(float) / np.clip(mixed, 1e-12, None)
    frames = mixture_candidates(group, scenario_weights, marginals, tilts)
    tickets = pick_tickets(frames, BET_CAPS, GROUPS)
    tickets.insert(0, "race_id", str(group["race_id"].iloc[0]))
    return tickets


def _ticket_worker(name: str) -> tuple[str, dict]:
    e: pd.DataFrame = _CTX["e"]  # type: ignore[assignment]
    weights = _CTX["weights"].get(name)  # type: ignore[union-attr]
    if weights is not None:
        weights = weights.set_index("race_id")
    print(f"[tickets] {name}", flush=True)
    tickets = pd.concat([_race_tickets(g, weights) for _, g in e.groupby("race_id", sort=False)], ignore_index=True)
    hits = {bet: _per_race_hits(tickets.loc[tickets["bet_type"].eq(bet)], _CTX["outcomes"], _CTX["eligible"][bet])
            for bet in BET_TYPES}
    return name, hits


def main() -> None:
    history = Path(os.environ.get("REIN_HISTORY_PATH", "data/raw/jra/races-2019-2026.parquet"))
    raw = pd.read_parquet(history)
    raw["race_id"] = raw["race_id"].astype(str)
    x, designs = build_designs(raw, None)
    races, cuts = race_table(x)
    weights, scenario_quality = scenario_probabilities(races)
    probs = role_models(x, designs["v4"], races)
    e = evaluation_frame(x, probs)
    outcomes, eligible = build_outcomes(raw.loc[raw["race_id"].isin(set(e["race_id"]))])
    names = ["baseline", *BIAS_VARIANTS]
    _CTX.update({"e": e, "weights": weights, "outcomes": outcomes, "eligible": eligible})
    with mp.get_context("fork").Pool(processes=len(names)) as pool:
        hits = dict(pool.map(_ticket_worker, names))

    race_period = e.groupby("race_id")["period"].first()
    race_date = e.groupby("race_id")["race_date"].first()
    tickets = {}
    for period in ("selection_2025", "audit_2026"):
        ids = race_period.index[race_period.eq(period)]
        tickets[period] = {}
        for name in names:
            tickets[period][name] = {}
            for bet in BET_TYPES:
                h = hits[name][bet].reindex(ids).dropna()
                row = {"races": int(len(h)), "race_hit_rate": float(h.mean()) if len(h) else float("nan")}
                if name != "baseline":
                    diff = h - hits["baseline"][bet].reindex(h.index)
                    row["change_vs_production"] = day_bootstrap(diff, race_date.reindex(diff.index))
                tickets[period][name][bet] = row
    chosen = max(BIAS_VARIANTS, key=lambda n: sum(tickets["selection_2025"][n][b]["race_hit_rate"] for b in BET_TYPES))
    decision = {
        name: {bet: "pass" if all(tickets[p][name][bet]["change_vs_production"]["low"] > 0
                                  for p in ("selection_2025", "audit_2026")) else "hold" for bet in BET_TYPES}
        for name in BIAS_VARIANTS
    }
    report = {
        "scope": "Research only. Role and scenario models train through 2024; bias variant chosen on 2025; 2026 audit.",
        "baseline": "70% popularity + 30% v4 role probability, single Harville (production rule).",
        "scenario_cuts": cuts,
        "scenario_share_2019_2024": races.loc[races["race_date"].lt(TRAIN_END), "scenario"].value_counts(normalize=True).to_dict(),
        "scenario_model": scenario_quality,
        "chosen_on_2025": chosen,
        "scenario_spread": {role: float(np.abs(np.log(e[f"c_front_{role}"] / e[f"c_closer_{role}"])).mean())
                            for role in POSITIONS},
        "tickets": tickets,
        "decision": decision,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=float))
    bet_labels = {"win": "単勝", "place": "複勝", "bracket_quinella": "枠連", "quinella": "馬連",
                  "wide": "ワイド", "exacta": "馬単", "trio": "3連複", "trifecta": "3連単"}
    labels = {"baseline": "現行(人気70%+v4 30%)", "mix_nobias": "展開混合", "mix_bias_shrunk": "展開混合+当日傾向(常時)",
              "mix_bias_gated": "展開混合+当日傾向(判定つき)"}
    lines = ["## REIN v8 研究: 展開シナリオ混合と当日馬場傾向", "",
             f"2025年で選んだ方式: {labels[chosen]}", "",
             "2026年の券種別レース的中率（括弧内は現行との差と日単位95%区間、ポイント）", "",
             "|方式|" + "|".join(bet_labels[b] for b in BET_TYPES) + "|", "|---|" + "---:|" * len(BET_TYPES)]
    for name in names:
        cells = []
        for bet in BET_TYPES:
            row = tickets["audit_2026"][name][bet]
            cell = f"{row['race_hit_rate']:.2%}"
            if "change_vs_production" in row:
                c = row["change_vs_production"]
                cell += f" ({100 * c['mean']:+.2f} [{100 * c['low']:+.2f}, {100 * c['high']:+.2f}])"
            cells.append(cell)
        lines.append(f"|{labels[name]}|" + "|".join(cells) + "|")
    lines += ["", "採否（2025・2026両年で区間下限>0なら pass）", ""]
    for name, verdict in decision.items():
        passed = [bet_labels[b] for b in BET_TYPES if verdict[b] == "pass"]
        lines.append(f"- {labels[name]}: {', '.join(passed) or 'なし'}")
    g = scenario_quality["gate"]
    lines += ["", f"当日傾向の判定が有効になったレース: {g['gate_on_share']:.1%}（{g['gate_on_races']}R）、"
              f"判定の向きと実際の展開が一致 {g['direction_match']:.1%}・逆 {g['opposite']:.1%}"]
    summary = "\n".join(lines) + "\n"
    (OUT / "summary.md").write_text(summary)
    print(summary, flush=True)
    print("REIN_V8_JSON_BEGIN", flush=True)
    print(json.dumps({k: report[k] for k in ("scenario_cuts", "scenario_model", "chosen_on_2025", "decision")},
                     ensure_ascii=False, default=float), flush=True)
    print("REIN_V8_JSON_END", flush=True)


if __name__ == "__main__":
    main()
