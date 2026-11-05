"""REIN v7 research: learned market stacking and the REIN index, side by side.

Research only. Nothing here changes the deployed model, tickets or web app.

Protocol (JRA flat races):
- Role models (1st/2nd/3rd LightGBM, same settings as rein-role-v4) are refit on
  expanding windows so every prediction from 2022 on is out of sample:
  train < 2022 -> 2022, < 2023 -> 2023, < 2024 -> 2024, < 2025 -> 2025 and 2026.
  The last window is exactly the production training period (through 2024).
- Two role-model variants: ``v4`` (production features) and ``v7`` (v4 plus
  point-in-time REIN index features).  REIN index pars and the cushion prior
  use 2019-2021 only.
- The stacker (conditional logit per role) is fit on 2022-2024 out-of-sample
  predictions, its feature set and L2 are chosen on 2025, and 2026 is the audit.
- Every candidate is compared with the current production rule
  (70% popularity + 30% v4 role probability) and with popularity alone: role
  log loss, role Top-3/Top-5, and all eight ticket types under the current caps.
  Differences carry day-cluster bootstrap 95% intervals.

2026 has been looked at in earlier research, so a pass here is a reason to run a
prospective shadow comparison, not a reason to switch production directly.
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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))
from rein_research import prepare  # noqa: E402
from rein_research_v3 import add_v3_features  # noqa: E402
from rein_ticket_research_v4 import BET_TYPES, generate_all  # noqa: E402

from baken_academia.bet_strategy_comparison import build_outcomes  # noqa: E402
from baken_academia.features import build_feature_frame  # noqa: E402
from baken_academia.market_stack import (  # noqa: E402
    ROLES, ConditionalLogit, day_bootstrap, market_probability, normalize_within,
    role_log_loss, stack_features,
)
from baken_academia.rein_index import INDEX_FEATURES, add_index_features, build_rein_index  # noqa: E402

OUT = Path(os.environ.get("REIN_V7_OUTPUT", "reports/rein-v7-research"))
FOLD_YEARS = [int(y) for y in os.environ.get("REIN_V7_FOLD_YEARS", "2022,2023,2024,2025").split(",")]
ESTIMATORS = int(os.environ.get("REIN_V7_ESTIMATORS", "650"))
POSITIONS = {"first": 1, "second": 2, "third": 3}
BASELINE = "v4_70_30"
_CTX: dict[str, object] = {}


def build_designs(raw: pd.DataFrame, measurements: pd.DataFrame | None):
    print("[features] point-in-time history", flush=True)
    x, added = add_v3_features(prepare(raw))
    base, _, _ = build_feature_frame(x)
    inherited = [c for c in x if c.startswith(("prior_", "recent3_")) or "_recent90_" in c]
    inherited += ["expected_front_count", "relative_early"]
    names = list(dict.fromkeys(inherited + added))
    frame = pd.concat([base, x[names]], axis=1)
    x["wet_for_role"] = x["going"].isin(["重", "不良"]).astype(int)
    x["placed_for_wet_role"] = pd.to_numeric(x["finish_position"], errors="coerce").between(1, 3).astype(float)
    wet = x.groupby(["horse_id", "wet_for_role"], observed=True, dropna=False)
    x["horse_wet_prior_starts"] = wet.cumcount().astype(float)
    x["horse_wet_prior_top3_rate"] = (
        wet["placed_for_wet_role"].cumsum() - x["placed_for_wet_role"] + 4.5
    ) / (x["horse_wet_prior_starts"] + 20)
    third = ["horse_wet_prior_starts", "horse_wet_prior_top3_rate"]

    print("[index] REIN index with pars through 2021", flush=True)
    rated = build_rein_index(x, par_end="2021-12-31", measurements=measurements)
    rated, index_names = add_index_features(rated)
    x[index_names] = rated[index_names]
    x["rein_index"] = rated["rein_index"]
    x["track_variant"] = rated["track_variant"]

    designs = {
        "v4": {"first": frame, "second": frame, "third": pd.concat([frame, x[third]], axis=1)},
    }
    designs["v7"] = {role: pd.concat([d, x[index_names]], axis=1) for role, d in designs["v4"].items()}
    return x, designs


def fit_role_models(x: pd.DataFrame, designs) -> tuple[pd.DataFrame, dict]:
    flat = x["surface"].isin(["芝", "ダート"])
    dates = x["race_date"]
    probs = pd.DataFrame(index=x.index)
    importance = {}
    for variant, role_frames in designs.items():
        for role, design in role_frames.items():
            column = f"{variant}_{role}"
            probs[column] = np.nan
            y = pd.to_numeric(x["finish_position"], errors="coerce").eq(POSITIONS[role])
            for year in FOLD_YEARS:
                train = dates.lt(f"{year}-01-01") & flat
                target = dates.dt.year.eq(year) if year != FOLD_YEARS[-1] else dates.dt.year.ge(year)
                print(f"[model] {variant} {role} train<{year}", flush=True)
                model = lgb.LGBMClassifier(
                    n_estimators=ESTIMATORS, learning_rate=.03, num_leaves=15,
                    min_child_samples=250, feature_fraction=.8, bagging_fraction=.9,
                    bagging_freq=1, reg_lambda=8, n_jobs=4, verbosity=-1,
                    random_state=900 + POSITIONS[role],
                )
                model.fit(design.loc[train], y.loc[train])
                rows = target & flat
                probs.loc[rows, column] = model.predict_proba(design.loc[rows])[:, 1]
                if year == FOLD_YEARS[-1]:
                    gain = model.booster_.feature_importance("gain")
                    total = float(gain.sum()) or 1.0
                    ranked = sorted(zip(design.columns, gain / total), key=lambda item: -item[1])
                    importance[column] = {
                        "top": [[name, float(share)] for name, share in ranked[:15]],
                        "rein_index_share": float(sum(s for n, s in ranked if n in INDEX_FEATURES)),
                    }
    return probs, importance


def evaluation_frame(x: pd.DataFrame, probs: pd.DataFrame) -> pd.DataFrame:
    flat = x["surface"].isin(["芝", "ダート"])
    keep = flat & x["race_date"].dt.year.ge(min(FOLD_YEARS)) & probs.notna().all(axis=1)
    columns = ["race_id", "race_date", "horse_id", "horse_number", "gate", "popularity",
               "surface", "class_tier", "finish_position"]
    e = pd.concat([x.loc[keep, columns], probs.loc[keep]], axis=1)
    e = e.dropna(subset=["horse_number", "gate"])
    e["race_id"] = e["race_id"].astype(str)
    e = e.sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    e["field_size"] = e.groupby("race_id")["race_id"].transform("size")
    e = e.loc[e["field_size"].ge(4)].reset_index(drop=True)
    e["market_probability"] = market_probability(e["popularity"], e["race_id"])
    e["period"] = np.where(e["race_date"].dt.year.le(2024), "fit",
                           np.where(e["race_date"].dt.year.eq(2025), "selection_2025", "audit_2026"))
    for role, position in POSITIONS.items():
        e[f"is_{role}"] = pd.to_numeric(e["finish_position"], errors="coerce").eq(position).astype(int)
    return e


def stack_candidates(e: pd.DataFrame) -> tuple[dict[str, pd.DataFrame], dict]:
    candidates = {"popularity": pd.DataFrame({r: e["market_probability"] for r in ROLES})}
    chosen = {}
    for variant in ("v4", "v7"):
        role_probs = {r: normalize_within(e[f"{variant}_{r}"], e["race_id"]) for r in ROLES}
        candidates[f"{variant}_70_30"] = pd.DataFrame(
            {r: .7 * e["market_probability"] + .3 * role_probs[r] for r in ROLES})
        stack_input = e[["race_id", "market_probability", "field_size", "surface", "class_tier"]].copy()
        for r in ROLES:
            stack_input[f"{r}_probability"] = role_probs[r]
        stacked = {}
        chosen[variant] = {}
        fit = e["period"].eq("fit")
        sel = e["period"].eq("selection_2025")
        for role in ROLES:
            best = None
            for context in (False, True):
                features = stack_features(stack_input, role, context)
                for l2 in (1.0, 10.0, 100.0):
                    model = ConditionalLogit(l2=l2).fit(features.loc[fit], e.loc[fit, "race_id"], e.loc[fit, f"is_{role}"])
                    p = pd.Series(model.predict(features, e["race_id"]), index=e.index)
                    loss = role_log_loss(p.loc[sel], e.loc[sel, f"is_{role}"], e.loc[sel, "race_id"])
                    if best is None or loss < best[0]:
                        best = (loss, context, l2, p, model)
            loss, context, l2, p, model = best
            stacked[role] = p
            chosen[variant][role] = {"context": context, "l2": l2, "selection_log_loss": loss,
                                     "coefficients": model.coefficients()}
            print(f"[stack] {variant} {role} context={context} l2={l2} loss={loss:.5f}", flush=True)
        candidates[f"{variant}_stack"] = pd.DataFrame(stacked)
    return candidates, chosen


def role_metrics(e: pd.DataFrame, candidates: dict[str, pd.DataFrame]) -> dict:
    result = {}
    for period in ("selection_2025", "audit_2026"):
        part = e["period"].eq(period)
        sub = e.loc[part]
        result[period] = {}
        base_ll = {}
        for name, probs in candidates.items():
            out = {}
            for role in ROLES:
                p = probs.loc[part, role]
                hit = sub[f"is_{role}"].astype(bool)
                single = hit.groupby(sub["race_id"]).transform("sum").eq(1)
                per_race_ll = (-np.log(p.clip(lower=1e-15))).loc[hit & single].groupby(sub.loc[hit & single, "race_id"]).first()
                if name == BASELINE:
                    base_ll[role] = per_race_ll
                rank = p.groupby(sub["race_id"]).rank(ascending=False, method="first")
                top = {}
                for k in (1, 3, 5):
                    captured = (hit & rank.le(k)).groupby(sub["race_id"]).any()
                    races_with = hit.groupby(sub["race_id"]).any()
                    top[f"top{k}"] = float(captured.loc[races_with].mean())
                out[role] = {"log_loss": float(per_race_ll.mean()), "races": int(len(per_race_ll)), **top}
                out[role]["_per_race_ll"] = per_race_ll
            result[period][name] = out
        dates = sub.groupby("race_id")["race_date"].first()
        for name in candidates:
            for role in ROLES:
                ll = result[period][name][role].pop("_per_race_ll")
                if name != BASELINE:
                    diff = (base_ll[role] - ll).dropna()  # positive = better than production
                    result[period][name][role]["log_loss_gain_vs_production"] = day_bootstrap(diff, dates.reindex(diff.index))
    return result


def _per_race_hits(tickets: pd.DataFrame, outcomes: pd.DataFrame, eligible: set[str]) -> pd.Series:
    selected = tickets.loc[tickets["race_id"].isin(eligible)]
    checked = selected.merge(outcomes.assign(hit=True), on=["race_id", "bet_type", "selection"], how="left")
    checked["hit"] = checked["hit"].eq(True)
    return checked.groupby("race_id")["hit"].any().astype(float)


def _ticket_worker(name: str) -> tuple[str, dict]:
    e: pd.DataFrame = _CTX["e"]  # type: ignore[assignment]
    probs: pd.DataFrame = _CTX["candidates"][name]  # type: ignore[index]
    runners = e.loc[e["period"].ne("fit"), ["race_id", "race_date", "horse_number", "gate", "popularity"]].copy()
    for role in ROLES:
        runners[f"v4_{role}_probability"] = probs.loc[runners.index, role].to_numpy()
    runners["win_probability"] = runners["v4_first_probability"]
    print(f"[tickets] {name}", flush=True)
    tickets = generate_all(runners, (0.0, 0.0, 1.0))
    hits = {bet: _per_race_hits(tickets.loc[tickets["bet_type"].eq(bet)], _CTX["outcomes"], _CTX["eligible"][bet])
            for bet in BET_TYPES}
    points = tickets.groupby(["bet_type", "race_id"]).size().groupby("bet_type").mean().to_dict()
    return name, {"hits": hits, "points": points}


def ticket_metrics(e: pd.DataFrame, candidates: dict, raw: pd.DataFrame) -> dict:
    outcomes, eligible = build_outcomes(raw.loc[raw["race_id"].astype(str).isin(set(e["race_id"]))].assign(
        race_id=lambda d: d["race_id"].astype(str)))
    _CTX.update({"e": e, "candidates": candidates, "outcomes": outcomes, "eligible": eligible})
    with mp.get_context("fork").Pool(processes=min(4, len(candidates))) as pool:
        results = dict(pool.map(_ticket_worker, list(candidates)))
    race_period = e.groupby("race_id")["period"].first()
    race_date = e.groupby("race_id")["race_date"].first()
    report = {}
    for period in ("selection_2025", "audit_2026"):
        ids = race_period.index[race_period.eq(period)]
        report[period] = {}
        for name, data in results.items():
            report[period][name] = {}
            for bet in BET_TYPES:
                h = data["hits"][bet].reindex(ids).dropna()
                row = {"races": int(len(h)), "race_hit_rate": float(h.mean()) if len(h) else float("nan"),
                       "points": float(data["points"].get(bet, 0.0))}
                if name != BASELINE:
                    base = results[BASELINE]["hits"][bet].reindex(h.index)
                    diff = h - base
                    row["change_vs_production"] = day_bootstrap(diff, race_date.reindex(diff.index))
                report[period][name][bet] = row
    return report


def decide(roles: dict, tickets: dict) -> dict:
    """A candidate passes for a bet type when both periods' interval lows are > 0."""
    verdict = {}
    for name in tickets["audit_2026"]:
        if name == BASELINE:
            continue
        verdict[name] = {}
        for bet in BET_TYPES:
            lows = [tickets[p][name][bet].get("change_vs_production", {}).get("low", float("nan"))
                    for p in ("selection_2025", "audit_2026")]
            verdict[name][bet] = "pass" if all(l > 0 for l in lows) else "hold"
        verdict[name]["role_log_loss"] = {
            role: "pass" if all(roles[p][name][role].get("log_loss_gain_vs_production", {}).get("low", -1) > 0
                                for p in ("selection_2025", "audit_2026")) else "hold"
            for role in ROLES
        }
    return verdict


def summary_markdown(report: dict) -> str:
    labels = {"popularity": "人気のみ", "v4_70_30": "現行(人気70%+v4 30%)", "v4_stack": "市場合成(v4)",
              "v7_70_30": "人気70%+v7 30%", "v7_stack": "市場合成(v7=REIN指数入り)"}
    bet_labels = {"win": "単勝", "place": "複勝", "bracket_quinella": "枠連", "quinella": "馬連",
                  "wide": "ワイド", "exacta": "馬単", "trio": "3連複", "trifecta": "3連単"}
    lines = ["## REIN v7 研究: 市場合成とREIN指数", "",
             "2026年の券種別レース的中率（括弧内は現行との差と日単位95%区間、ポイント）", "",
             "|方式|" + "|".join(bet_labels[b] for b in BET_TYPES) + "|",
             "|---|" + "---:|" * len(BET_TYPES)]
    audit = report["tickets"]["audit_2026"]
    for name, label in labels.items():
        cells = []
        for bet in BET_TYPES:
            row = audit[name][bet]
            cell = f"{row['race_hit_rate']:.2%}"
            if "change_vs_production" in row:
                c = row["change_vs_production"]
                cell += f" ({100 * c['mean']:+.2f} [{100 * c['low']:+.2f}, {100 * c['high']:+.2f}])"
            cells.append(cell)
        lines.append(f"|{label}|" + "|".join(cells) + "|")
    lines += ["", "採否（2025・2026両年で区間下限>0なら pass）", ""]
    for name, verdict in report["decision"].items():
        passed = [bet_labels[b] for b in BET_TYPES if verdict[b] == "pass"]
        roles = ", ".join(f"{r}:{v}" for r, v in verdict["role_log_loss"].items())
        lines.append(f"- {labels[name]}: 的中率 pass = {', '.join(passed) or 'なし'} / 着順別対数損失 {roles}")
    share = report["importance"].get("v7_first", {}).get("rein_index_share")
    if share is not None:
        lines += ["", f"v7の1着モデルでREIN指数特徴量が占める重要度（gain）: {share:.1%}"]
    return "\n".join(lines) + "\n"


def main() -> None:
    history = Path(os.environ.get("REIN_HISTORY_PATH", "data/raw/jra/races-2019-2026.parquet"))
    raw = pd.read_parquet(history)
    raw["race_id"] = raw["race_id"].astype(str)
    measurements = None
    m_path = os.environ.get("REIN_V7_MEASUREMENTS")
    if m_path and Path(m_path).exists():
        measurements = pd.DataFrame(json.loads(Path(m_path).read_text()))
        print(f"[index] cushion/moisture records: {len(measurements)}", flush=True)
    x, designs = build_designs(raw, measurements)
    probs, importance = fit_role_models(x, designs)
    e = evaluation_frame(x, probs)
    candidates, chosen = stack_candidates(e)
    roles = role_metrics(e, candidates)
    tickets = ticket_metrics(e, candidates, raw)
    index_rows = x.loc[x["surface"].isin(["芝", "ダート"])]
    report = {
        "scope": "Research only. Expanding-window role models; stacker fit 2022-2024, chosen on 2025, audited on 2026.",
        "baseline": BASELINE,
        "fold_years": FOLD_YEARS,
        "races": {p: int(e.loc[e["period"].eq(p), "race_id"].nunique()) for p in ("fit", "selection_2025", "audit_2026")},
        "rein_index": {
            "rated_share": float(index_rows["rein_index"].notna().mean()),
            "cushion_prior": measurements is not None,
            "feature_coverage_2026": float(index_rows.loc[index_rows["race_date"].dt.year.eq(2026), "rein_index_prior"].notna().mean()),
        },
        "importance": importance,
        "stacker": chosen,
        "roles": roles,
        "tickets": tickets,
    }
    report["decision"] = decide(roles, tickets)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=float))
    summary = summary_markdown(report)
    (OUT / "summary.md").write_text(summary)
    print(summary, flush=True)
    print("REIN_V7_JSON_BEGIN", flush=True)
    print(json.dumps({k: report[k] for k in ("races", "rein_index", "decision", "stacker")}, ensure_ascii=False, default=float), flush=True)
    print("REIN_V7_JSON_END", flush=True)


if __name__ == "__main__":
    main()
