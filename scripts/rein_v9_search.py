"""REIN v9: search tens of thousands of prediction and ticket configurations.

Research only. Nothing here changes the deployed model, tickets or web app.

What is searched (one configuration = one choice of each):
- role source: production features (v4) or v4 + REIN index (v7)
- combination with the market: a linear blend (market weight 50-100%, market
  from 1 / popularity^alpha) or the learned conditional-logit stacker
- per-role temperature (sharpening/flattening 1st, 2nd and 3rd probabilities)
- race-shape scenario tilt strength (0 = off) and the same-day bias setting
  that feeds the scenario model (none, always-on, or gated with several
  minimum-race and z thresholds)
- number of runners kept when enumerating combinations

Guarding against luck when trying this many:
- Every probability comes from models trained strictly before the year it
  scores (expanding windows), and the stacker is fit on 2022 only.
- Stage A screens all configurations on a fixed random sample of 2023-2024
  races; stage B rescores the best per bet type on all 2023-2024 races;
  stage C picks among the top 10 per bet type on 2025; 2026 is the audit and
  is never used to choose.  Differences against production carry day-cluster
  bootstrap intervals, and the report lists the 2026 result of every top-10
  configuration, not only the chosen one, so selection luck is visible.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
import sys
import time
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
from rein_v7_research import build_designs, fit_role_models  # noqa: E402
from rein_v8_research import race_table  # noqa: E402

from baken_academia.market_stack import (  # noqa: E402
    ConditionalLogit, day_bootstrap, market_probability, normalize_within, stack_features,
)
from baken_academia.race_scenarios import SCENARIOS  # noqa: E402
from baken_academia.ticket_search import BET_TYPES, RaceArrays, evaluate_hits, pad_races  # noqa: E402

OUT = Path(os.environ.get("REIN_V9_OUTPUT", "reports/rein-v9-search"))
N_CONFIGS = int(os.environ.get("REIN_V9_CONFIGS", "30000"))
SAMPLE_RACES = int(os.environ.get("REIN_V9_SAMPLE_RACES", "1500"))
WORKERS = int(os.environ.get("REIN_V9_WORKERS", "4"))
ESTIMATORS = int(os.environ.get("REIN_V7_ESTIMATORS", "650"))
FOLD_YEARS = [2022, 2023, 2024, 2025]
ROLES = ("first", "second", "third")
POSITIONS = {"first": 1, "second": 2, "third": 3}
MULTI = ("bracket_quinella", "quinella", "wide", "exacta", "trio", "trifecta")
BIAS_SETTINGS = ["none", "shrunk"] + [f"gated_m{m}_z{z}" for m in (2, 3, 4) for z in (1.5, 2.0, 2.5)]
PRODUCTION = {"source": "v4", "combiner": "blend", "w_market": 0.7, "alpha": 1.0, "ctx": 0, "l2": 0,
              "tau": [1.0, 1.0, 1.0], "gamma": 0.0, "bias": "none", "support": 9}
_G: dict[str, object] = {}


# ---------------------------------------------------------------- models
def fold_rows(dates: pd.Series, year: int) -> pd.Series:
    return dates.dt.year.eq(year) if year != FOLD_YEARS[-1] else dates.dt.year.ge(year)


def conditional_models(x: pd.DataFrame, design: pd.DataFrame, races: pd.DataFrame) -> pd.DataFrame:
    """p(role | scenario) from v4 features + realized scenario, expanding windows."""
    flat = x["surface"].isin(["芝", "ダート"])
    scenario = x[["race_id"]].merge(races[["race_id", "scenario"]], on="race_id", how="left")["scenario"].to_numpy()
    cond = design.copy()
    cond["scenario_front"] = (scenario == "front").astype(float)
    cond["scenario_closer"] = (scenario == "closer").astype(float)
    labelled = pd.Series(pd.notna(scenario), index=x.index)
    out = pd.DataFrame(index=x.index)
    for role, position in POSITIONS.items():
        y = pd.to_numeric(x["finish_position"], errors="coerce").eq(position)
        for s in SCENARIOS:
            out[f"cond_{s}_{role}"] = np.nan
        for year in FOLD_YEARS:
            train = x["race_date"].lt(f"{year}-01-01") & flat & labelled
            rows = fold_rows(x["race_date"], year) & flat
            print(f"[cond] {role} train<{year}", flush=True)
            model = lgb.LGBMClassifier(
                n_estimators=ESTIMATORS, learning_rate=.03, num_leaves=15, min_child_samples=250,
                feature_fraction=.8, bagging_fraction=.9, bagging_freq=1, reg_lambda=8, n_jobs=4,
                verbosity=-1, random_state=950 + position,
            ).fit(cond.loc[train], y.loc[train])
            for s in SCENARIOS:
                what_if = cond.loc[rows].copy()
                what_if["scenario_front"] = float(s == "front")
                what_if["scenario_closer"] = float(s == "closer")
                out.loc[rows, f"cond_{s}_{role}"] = model.predict_proba(what_if)[:, 1]
    return out


def bias_column(races: pd.DataFrame, setting: str) -> pd.Series | None:
    if setting == "none":
        return None
    if setting == "shrunk":
        return races["bias_shrunk"]
    m, z = setting.removeprefix("gated_m").split("_z")
    gate = races["bias_races"].ge(int(m)) & races["bias_z"].abs().ge(float(z))
    return races["bias_shrunk"] * gate.astype(float)


def scenario_weights(races: pd.DataFrame) -> dict[str, pd.DataFrame]:
    numeric = ["field_size", "front_pressure_share", "known_style_share", "expected_front_count",
               "distance_m", "class_tier", "mean_prior_early"]
    categorical = ["racecourse", "surface", "going"]
    flat = races["surface"].isin(["芝", "ダート"])
    result = {}
    for setting in BIAS_SETTINGS:
        frame = races[numeric + categorical].copy()
        cols = list(numeric)
        extra = bias_column(races, setting)
        if extra is not None:
            frame["bias"] = extra
            cols.append("bias")
        frame[cols] = frame[cols].apply(pd.to_numeric, errors="coerce")
        frame[cols] = frame[cols].fillna(frame[cols].median())
        frame[categorical] = frame[categorical].fillna("missing").astype(str)
        proba = pd.DataFrame(np.nan, index=races.index, columns=list(SCENARIOS))
        for year in FOLD_YEARS:
            train = races["race_date"].lt(f"{year}-01-01") & races["scenario"].notna() & flat
            rows = fold_rows(races["race_date"], year)
            model = make_pipeline(
                ColumnTransformer([("num", StandardScaler(), cols),
                                   ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=50), categorical)]),
                LogisticRegression(C=0.5, max_iter=2000),
            ).fit(frame.loc[train], races.loc[train, "scenario"])
            p = pd.DataFrame(model.predict_proba(frame.loc[rows]), columns=model.classes_, index=frame.index[rows])
            proba.loc[rows, list(SCENARIOS)] = p[list(SCENARIOS)].to_numpy()
        proba.insert(0, "race_id", races["race_id"].to_numpy())
        result[setting] = proba
        print(f"[scenario] {setting}", flush=True)
    return result


def stack_sets(e: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Conditional-logit stackers fit on 2022 out-of-sample rows only."""
    fit = e["race_date"].dt.year.eq(2022)
    out = {}
    for source in ("v4", "v7"):
        inp = e[["race_id", "market_probability", "field_size", "surface", "class_tier"]].copy()
        for r in ROLES:
            inp[f"{r}_probability"] = normalize_within(e[f"{source}_{r}"], e["race_id"])
        for ctx in (0, 1):
            for l2 in (1.0, 10.0, 100.0):
                probs = {}
                for role in ROLES:
                    f = stack_features(inp, role, bool(ctx))
                    model = ConditionalLogit(l2=l2).fit(f.loc[fit], e.loc[fit, "race_id"], e.loc[fit, f"is_{role}"])
                    probs[role] = model.predict(f, e["race_id"])
                out[f"{source}_c{ctx}_l{int(l2)}"] = pd.DataFrame(probs, index=e.index)
                print(f"[stack] {source} ctx={ctx} l2={l2}", flush=True)
    return out


# ---------------------------------------------------------------- arrays
def build_arrays(x: pd.DataFrame, probs: pd.DataFrame, cond: pd.DataFrame, races: pd.DataFrame,
                 weights: dict[str, pd.DataFrame]):
    flat = x["surface"].isin(["芝", "ダート"])
    keep = flat & x["race_date"].dt.year.ge(2022) & probs.notna().all(axis=1) & cond.notna().all(axis=1)
    cols = ["race_id", "race_date", "horse_number", "gate", "popularity", "surface", "class_tier", "finish_position"]
    e = pd.concat([x.loc[keep, cols], probs.loc[keep], cond.loc[keep]], axis=1).dropna(subset=["horse_number", "gate"])
    e["race_id"] = e["race_id"].astype(str)
    e = e.sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    e["field_size"] = e.groupby("race_id")["race_id"].transform("size")
    e = e.loc[e["field_size"].between(4, 18)].reset_index(drop=True)
    e["market_probability"] = market_probability(e["popularity"], e["race_id"])
    for role, position in POSITIONS.items():
        e[f"is_{role}"] = pd.to_numeric(e["finish_position"], errors="coerce").eq(position).astype(int)
    stacks = stack_sets(e)
    pop = pd.to_numeric(e["popularity"], errors="coerce")
    fallback = pop.groupby(e["race_id"]).transform("max").fillna(0)
    e["pop_filled"] = pop.fillna(np.maximum(fallback, e["field_size"]) + 1).clip(lower=1)
    columns = {"pop": "pop_filled", "gate": "gate", "finish": "finish_position"}
    for source in ("v4", "v7"):
        for r in ROLES:
            columns[f"{source}_{r}"] = f"{source}_{r}"
    for s in SCENARIOS:
        for r in ROLES:
            columns[f"cond_{s}_{r}"] = f"cond_{s}_{r}"
    for name, frame in stacks.items():
        for r in ROLES:
            e[f"stack_{name}_{r}"] = frame[r].to_numpy()
            columns[f"stack_{name}_{r}"] = f"stack_{name}_{r}"
    e["finish_position"] = pd.to_numeric(e["finish_position"], errors="coerce").fillna(0)
    race_ids, mask, arrays = pad_races(e, columns)
    meta = e.groupby("race_id", sort=False).agg(race_date=("race_date", "first"), field=("field_size", "first"))
    meta = meta.loc[race_ids]
    w = {}
    for setting, frame in weights.items():
        w[setting] = frame.set_index("race_id").reindex(race_ids)[list(SCENARIOS)].to_numpy(float)
    arrays["gate"] = arrays["gate"].astype(int)
    arrays["finish"] = arrays["finish"].astype(int)
    return race_ids, mask, arrays, meta, w


# ---------------------------------------------------------------- configs
def sample_configs(n: int, seed: int = 20261105) -> list[dict]:
    rng = np.random.default_rng(seed)
    configs = [PRODUCTION]
    seen = {json.dumps(PRODUCTION, sort_keys=True)}
    while len(configs) < n:
        c = {"source": str(rng.choice(["v4", "v7"])), "combiner": str(rng.choice(["blend", "stack"]))}
        if c["combiner"] == "blend":
            c.update(w_market=float(rng.choice(np.round(np.arange(.5, 1.001, .05), 2))),
                     alpha=float(rng.choice([.6, .8, 1.0, 1.2, 1.4, 1.7, 2.0])), ctx=0, l2=0)
        else:
            c.update(w_market=0.0, alpha=1.0, ctx=int(rng.integers(0, 2)), l2=int(rng.choice([1, 10, 100])))
        c["tau"] = [float(rng.choice([.8, .9, 1.0, 1.1, 1.25])) for _ in ROLES]
        c["gamma"] = float(rng.choice([0, 0, .25, .5, .75, 1.0, 1.5]))
        c["bias"] = str(rng.choice(BIAS_SETTINGS)) if c["gamma"] > 0 else "none"
        c["support"] = int(rng.choice([9, 11]))
        key = json.dumps(c, sort_keys=True)
        if key not in seen:
            seen.add(key)
            configs.append(c)
    return configs


def _normalize(a: np.ndarray, mask: np.ndarray) -> np.ndarray:
    a = np.where(mask[..., None] if a.ndim == mask.ndim + 1 else mask, a, 0.0)
    return a / np.clip(a.sum(axis=1, keepdims=True), 1e-15, None)


def config_roles(c: dict, idx: np.ndarray):
    A, mask = _G["arrays"], _G["mask"][idx]  # type: ignore[index]
    if c["combiner"] == "blend":
        market = _normalize(np.where(mask, A["pop"][idx], 1.0) ** -c["alpha"], mask)
        src = np.stack([_normalize(A[f"{c['source']}_{r}"][idx], mask) for r in ROLES], axis=2)
        M = c["w_market"] * market[:, :, None] + (1 - c["w_market"]) * src
    else:
        name = f"stack_{c['source']}_c{c['ctx']}_l{c['l2']}"
        M = np.stack([A[f"{name}_{r}"][idx] for r in ROLES], axis=2)
    M = np.clip(M, 1e-12, None) ** np.asarray(c["tau"])[None, None, :]
    M = _normalize(M, mask)
    if c["gamma"] <= 0:
        return M, None
    cond = np.stack([np.stack([_normalize(A[f"cond_{s}_{r}"][idx], mask) for r in ROLES], axis=2)
                     for s in SCENARIOS], axis=2)                     # (R, N, S, 3)
    w = _G["weights"][c["bias"]][idx]                                   # type: ignore[index]
    w = np.where(np.isfinite(w), w, 1 / 3)
    cbar = (cond * w[:, None, :, None]).sum(axis=2, keepdims=True)
    tilt = (cond / np.clip(cbar, 1e-12, None)) ** c["gamma"]
    roles = M[:, :, None, :] * tilt
    roles = roles / np.clip(roles.sum(axis=1, keepdims=True), 1e-15, None)
    return roles, w


def score(c: dict, idx: np.ndarray, chunk: int = 400) -> dict[str, np.ndarray]:
    out = {b: [] for b in BET_TYPES}
    for start in range(0, len(idx), chunk):
        part = idx[start:start + chunk]
        races = RaceArrays(_G["mask"][part], _G["arrays"]["gate"][part], _G["arrays"]["finish"][part],  # type: ignore[index]
                           _G["field"][part])                                                           # type: ignore[index]
        roles, w = config_roles(c, part)
        hits = evaluate_hits(races, roles, w, support=c["support"])
        for b in BET_TYPES:
            out[b].append(hits[b])
    return {b: np.concatenate(v) for b, v in out.items()}


def _screen(item: tuple[int, dict]) -> tuple[int, dict[str, float]]:
    i, c = item
    hits = score(c, _G["sample_idx"])  # type: ignore[arg-type]
    if i % 500 == 0:
        print(f"[screen] {i}", flush=True)
    return i, {b: float(np.nanmean(h)) for b, h in hits.items()}


def _full(item: tuple[int, dict, str]) -> tuple[int, str, dict[str, np.ndarray]]:
    i, c, period = item
    return i, period, score(c, _G[f"{period}_idx"])  # type: ignore[arg-type]


# ---------------------------------------------------------------- main
def main() -> None:
    t0 = time.time()
    raw = pd.read_parquet(Path(os.environ.get("REIN_HISTORY_PATH", "data/raw/jra/races-2019-2026.parquet")))
    raw["race_id"] = raw["race_id"].astype(str)
    measurements = None
    m_path = os.environ.get("REIN_V7_MEASUREMENTS")
    if m_path and Path(m_path).exists():
        measurements = pd.DataFrame(json.loads(Path(m_path).read_text()))
    x, designs = build_designs(raw, measurements)
    races, cuts = race_table(x)
    probs, _ = fit_role_models(x, designs)
    cond = conditional_models(x, designs["v4"]["first"], races)
    weights = scenario_weights(races)
    race_ids, mask, arrays, meta, w = build_arrays(x, probs, cond, races, weights)
    years = pd.to_datetime(meta["race_date"]).dt.year.to_numpy()
    rng = np.random.default_rng(7)
    search_idx = np.flatnonzero((years == 2023) | (years == 2024))
    sample_idx = np.sort(rng.choice(search_idx, size=min(SAMPLE_RACES, len(search_idx)), replace=False))
    _G.update({"arrays": arrays, "mask": mask, "field": meta["field"].to_numpy(int), "weights": w,
               "sample_idx": sample_idx, "search_idx": search_idx,
               "confirm_idx": np.flatnonzero(years == 2025), "audit_idx": np.flatnonzero(years == 2026)})
    print(f"[data] ready in {time.time() - t0:.0f}s; races search={len(search_idx)} "
          f"confirm={len(_G['confirm_idx'])} audit={len(_G['audit_idx'])}", flush=True)

    configs = sample_configs(N_CONFIGS)
    with mp.get_context("fork").Pool(WORKERS) as pool:
        screened = dict(pool.map(_screen, list(enumerate(configs)), chunksize=20))
    print(f"[screen] done in {time.time() - t0:.0f}s", flush=True)
    screen = pd.DataFrame.from_dict(screened, orient="index").sort_index()
    screen["multi_mean"] = screen[list(MULTI)].mean(axis=1)

    targets = list(BET_TYPES) + ["multi_mean"]
    stage_b = sorted({0} | {int(i) for t in targets for i in screen[t].nlargest(120).index})
    with mp.get_context("fork").Pool(WORKERS) as pool:
        full = pool.map(_full, [(i, configs[i], "search") for i in stage_b])
    search_hits = {i: h for i, _, h in full}
    search = pd.DataFrame({i: {b: float(np.nanmean(h[b])) for b in BET_TYPES} for i, h in search_hits.items()}).T
    search["multi_mean"] = search[list(MULTI)].mean(axis=1)
    finalists = {t: [int(i) for i in search[t].nlargest(10).index] for t in targets}
    stage_c = sorted({0} | {i for v in finalists.values() for i in v})
    with mp.get_context("fork").Pool(WORKERS) as pool:
        later = pool.map(_full, [(i, configs[i], p) for i in stage_c for p in ("confirm", "audit")])
    hits = {(i, p): h for i, p, h in later}
    print(f"[stages] done in {time.time() - t0:.0f}s", flush=True)

    dates = pd.to_datetime(meta["race_date"]).to_numpy()

    def compare(i: int, period: str, bets: tuple[str, ...]) -> dict:
        idx = _G[f"{period}_idx"]
        cand = np.nanmean(np.stack([hits[(i, period)][b] for b in bets]), axis=0)
        base = np.nanmean(np.stack([hits[(0, period)][b] for b in bets]), axis=0)
        diff = pd.Series(cand - base)
        ok = diff.notna()
        ci = day_bootstrap(diff[ok], pd.Series(dates[idx])[ok.to_numpy()])
        return {"rate": float(np.nanmean(cand)), "production": float(np.nanmean(base)), "change": ci}

    results = {}
    for t in targets:
        bets = MULTI if t == "multi_mean" else (t,)
        rows = []
        for i in finalists[t]:
            rows.append({"config_id": i, "config": configs[i], "search": float(search.loc[i, t]),
                         "confirm": compare(i, "confirm", bets), "audit": compare(i, "audit", bets)})
        chosen = max(rows, key=lambda r: r["confirm"]["rate"])
        passed = chosen["confirm"]["change"]["low"] > 0 and chosen["audit"]["change"]["low"] > 0
        results[t] = {"chosen": chosen, "pass": bool(passed), "finalists": rows,
                      "audit_change_of_finalists": [r["audit"]["change"]["mean"] for r in rows]}

    # What each design choice contributes, averaged over the screened configurations.
    flat_cfg = pd.json_normalize(configs)
    flat_cfg["tau_mean"] = [float(np.mean(c["tau"])) for c in configs]
    flat_cfg["scenario_on"] = flat_cfg["gamma"].gt(0)
    flat_cfg["bias_kind"] = flat_cfg["bias"].str.extract(r"^(none|shrunk|gated)")[0]
    lift = screen["multi_mean"] - screen.loc[0, "multi_mean"]
    contributions = {}
    blend = flat_cfg["combiner"].eq("blend")
    for column in ("source", "combiner", "scenario_on", "bias_kind", "support", "gamma", "alpha", "w_market"):
        rows = blend if column in ("alpha", "w_market") else slice(None)  # only blends vary these
        contributions[column] = {str(k): float(v) for k, v in lift[rows].groupby(flat_cfg.loc[rows, column]).mean().items()}

    report = {
        "scope": "Research only. Expanding-window models; stage A sample of 2023-2024, stage B all 2023-2024, "
                 "stage C choose among top 10 on 2025, 2026 audit never used to choose.",
        "configs_screened": len(configs), "sample_races": int(len(sample_idx)),
        "races": {"search": int(len(search_idx)), "confirm": int(len(_G["confirm_idx"])), "audit": int(len(_G["audit_idx"]))},
        "production_screen": screen.loc[0].to_dict(), "scenario_cuts": cuts,
        "results": results, "contributions_multi_mean_vs_production": contributions,
        "elapsed_seconds": round(time.time() - t0),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=float))
    screen.join(flat_cfg).to_csv(OUT / "screen.csv.gz", index_label="config_id")
    labels = {"win": "単勝", "place": "複勝", "bracket_quinella": "枠連", "quinella": "馬連", "wide": "ワイド",
              "exacta": "馬単", "trio": "3連複", "trifecta": "3連単", "multi_mean": "複数馬6券種の平均"}
    lines = [f"## REIN v9 探索: {len(configs):,}通りの設定", "",
             "2025年で選んだ設定の2026年結果（現行との差・日単位95%区間、ポイント）", "",
             "|対象|現行2026|選択設定2026|差|2025の差|採否|2026での上位10設定の差の範囲|",
             "|---|---:|---:|---|---|---|---|"]
    for t in targets:
        r = results[t]
        a, cf = r["chosen"]["audit"], r["chosen"]["confirm"]
        span = r["audit_change_of_finalists"]
        lines.append(f"|{labels[t]}|{a['production']:.2%}|{a['rate']:.2%}|"
                     f"{100 * a['change']['mean']:+.2f} [{100 * a['change']['low']:+.2f}, {100 * a['change']['high']:+.2f}]|"
                     f"{100 * cf['change']['mean']:+.2f} [{100 * cf['change']['low']:+.2f}, {100 * cf['change']['high']:+.2f}]|"
                     f"{'pass' if r['pass'] else 'hold'}|{100 * min(span):+.2f}〜{100 * max(span):+.2f}|")
    lines += ["", "設計要素ごとの平均上積み（スクリーニング、複数馬6券種平均、現行比ポイント）", ""]
    for column, values in contributions.items():
        lines.append(f"- {column}: " + ", ".join(f"{k}: {100 * v:+.2f}" for k, v in values.items()))
    lines += ["", "選ばれた設定（複数馬6券種の平均）: `" + json.dumps(results["multi_mean"]["chosen"]["config"], ensure_ascii=False) + "`"]
    summary = "\n".join(lines) + "\n"
    (OUT / "summary.md").write_text(summary)
    print(summary, flush=True)
    print("REIN_V9_JSON_BEGIN", flush=True)
    print(json.dumps({"results": {t: {"chosen": r["chosen"], "pass": r["pass"]} for t, r in results.items()},
                      "contributions": contributions}, ensure_ascii=False, default=float), flush=True)
    print("REIN_V9_JSON_END", flush=True)


if __name__ == "__main__":
    main()
