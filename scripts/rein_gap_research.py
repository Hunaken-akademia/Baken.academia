"""REIN gap research: does "REIN rates this horse above the market" find value horses?

Research only. Nothing here changes the deployed model, tickets or web app.

Protocol (JRA flat races, final win odds from the jra-final-odds release):
- Expanding windows: for each test year Y in REIN_GAP_FOLD_YEARS, every model is
  fit on races before Y-01-01 and predicts Y only, so every prediction is out of
  sample. The last fold (2025) covers only the months the odds release holds.
- Three LightGBM win models per fold:
  * role:   production-style first-place model, history features only (no odds).
            Its in-race rank is the REIN "1着適性" order used to pick 穴候補.
  * market: odds-only model (log odds, implied probability, odds rank, field).
  * rein:   market features plus every history feature.
  ``ratio`` = rein / market win probability (both normalised within the race),
  the same idea as the production market-difference score.
- Selections are fixed before looking at results: the production 穴候補 rule
  (1着適性 3-6位, 4番人気以下, rein > market, first candidate), all candidates,
  and wider ratio cut-offs that return more horses per race.
- Every selection is compared with horses in the same win-odds band of the same
  year (win ROI and top-3 rate), so the long-shot bias cannot masquerade as edge.
  Pooled differences carry day-cluster bootstrap 95% intervals.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tarfile
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))

OUT = Path(os.environ.get("REIN_GAP_OUTPUT", "reports/rein-gap-research"))
FOLD_YEARS = [int(y) for y in os.environ.get("REIN_GAP_FOLD_YEARS", "2021,2022,2023,2024,2025").split(",")]
ESTIMATORS = int(os.environ.get("REIN_GAP_ESTIMATORS", "500"))
BANDS = [0, 3, 5, 7, 10, 15, 20, 30, 50, 100, np.inf]
BAND_LABELS = ["<3", "3-5", "5-7", "7-10", "10-15", "15-20", "20-30", "30-50", "50-100", "100+"]
MARKET_FEATURES = ["log_odds", "implied", "odds_rank", "odds_rank_pct", "field_size_m", "fav_implied"]


def load_odds(root: Path) -> pd.DataFrame:
    frames = []
    for path in sorted(root.rglob("jra-final-odds-*.tar.gz")):
        with tarfile.open(path, "r:gz") as t:
            members = [m for m in t.getmembers() if m.isfile() and m.name.endswith(".parquet")]
            for m in members:
                frames.append(pd.read_parquet(io.BytesIO(t.extractfile(m).read()))[["race_id", "horse_number", "win_odds"]])
    x = pd.concat(frames, ignore_index=True)
    x["race_id"] = x["race_id"].astype(str)
    x["horse_number"] = pd.to_numeric(x["horse_number"], errors="coerce")
    x["win_odds"] = pd.to_numeric(x["win_odds"], errors="coerce")
    return x.dropna().drop_duplicates(["race_id", "horse_number"])


def add_market_features(e: pd.DataFrame) -> pd.DataFrame:
    e = e.copy()
    race = e["race_id"]
    e["log_odds"] = np.log(e["win_odds"])
    inv = 1 / e["win_odds"]
    e["implied"] = inv / inv.groupby(race).transform("sum")
    e["odds_rank"] = e.groupby("race_id")["win_odds"].rank(method="min")
    e["field_size_m"] = race.groupby(race).transform("size").astype(float)
    e["odds_rank_pct"] = e["odds_rank"] / e["field_size_m"]
    e["fav_implied"] = e.groupby("race_id")["implied"].transform("max")
    return e


def normalize(values: np.ndarray, race: pd.Series) -> np.ndarray:
    s = pd.Series(values, index=race.index)
    return (s / s.groupby(race).transform("sum")).to_numpy()


def fit_predict(design: pd.DataFrame, y: pd.Series, dates: pd.Series, race: pd.Series, seed: int) -> np.ndarray:
    out = np.full(len(design), np.nan)
    for year in FOLD_YEARS:
        train = dates.lt(f"{year}-01-01")
        test = dates.dt.year.eq(year)
        if not test.any():
            continue
        print(f"[model] seed={seed} train<{year} rows={int(train.sum())} test={int(test.sum())}", flush=True)
        model = lgb.LGBMClassifier(
            n_estimators=ESTIMATORS, learning_rate=.03, num_leaves=15, min_child_samples=250,
            feature_fraction=.8, bagging_fraction=.9, bagging_freq=1, reg_lambda=8,
            n_jobs=4, verbosity=-1, random_state=seed,
        )
        model.fit(design.loc[train], y.loc[train])
        out[test.to_numpy()] = model.predict_proba(design.loc[test])[:, 1]
    keep = ~np.isnan(out)
    out[keep] = normalize(out[keep], race[keep])
    return out


def build_frame(raw: pd.DataFrame, odds: pd.DataFrame) -> pd.DataFrame:
    from rein_research import prepare  # noqa: E402
    from rein_research_v3 import add_v3_features  # noqa: E402
    from baken_academia.features import build_feature_frame  # noqa: E402

    print("[features] point-in-time history", flush=True)
    x, added = add_v3_features(prepare(raw))
    base, _, _ = build_feature_frame(x)
    inherited = [c for c in x if c.startswith(("prior_", "recent3_")) or "_recent90_" in c]
    inherited += ["expected_front_count", "relative_early"]
    names = list(dict.fromkeys(inherited + added))
    history = pd.concat([base, x[names]], axis=1)
    history = history.loc[:, ~history.columns.duplicated()]
    x["race_id"] = x["race_id"].astype(str)
    x["horse_number"] = pd.to_numeric(x["horse_number"], errors="coerce")
    merged = x[["race_id", "horse_number"]].merge(odds, on=["race_id", "horse_number"], how="left")
    x["win_odds"] = merged["win_odds"].to_numpy()
    flat = x["surface"].isin(["芝", "ダート"]) & x["win_odds"].gt(0)
    # A race only counts when every starter has odds, so implied probabilities are complete.
    complete = flat.groupby(x["race_id"]).transform("all")
    keep = complete & x["race_date"].dt.year.ge(2019)
    x, history = x.loc[keep].reset_index(drop=True), history.loc[keep].reset_index(drop=True)
    x = add_market_features(x)

    y = pd.to_numeric(x["finish_position"], errors="coerce").eq(1).astype(int)
    race, dates = x["race_id"], x["race_date"]
    market_design = x[MARKET_FEATURES]
    x["p_role"] = fit_predict(history, y, dates, race, seed=901)
    x["p_market"] = fit_predict(market_design, y, dates, race, seed=902)
    x["p_rein"] = fit_predict(pd.concat([history, market_design], axis=1), y, dates, race, seed=903)
    return x.loc[x["p_role"].notna()].reset_index(drop=True)


def selections(e: pd.DataFrame) -> dict[str, pd.Series]:
    """Fixed rules; ``e`` must carry role_rank and ratio."""
    pop = pd.to_numeric(e["popularity"], errors="coerce")
    candidate = e["role_rank"].between(3, 6) & pop.ge(4) & e["ratio"].gt(1)
    first = candidate & e.loc[candidate].groupby("race_id")["role_rank"].rank(method="first").reindex(e.index).eq(1)
    outside = pop.ge(4)
    return {
        "全馬": pd.Series(True, index=e.index),
        "穴候補（本番と同じ決め方・1頭）": first,
        "穴候補（条件に合う全頭）": candidate,
        "1着適性3〜8位・4番人気以下・REIN>市場": e["role_rank"].between(3, 8) & outside & e["ratio"].gt(1),
        "4番人気以下・REIN/市場1.1倍以上": outside & e["ratio"].ge(1.1),
        "4番人気以下・REIN/市場1.25倍以上": outside & e["ratio"].ge(1.25),
        "4番人気以下・REIN/市場1.5倍以上": outside & e["ratio"].ge(1.5),
        "4番人気以下・REIN/市場0.8倍未満（逆）": outside & e["ratio"].lt(0.8),
        "1〜3番人気・REIN/市場1.1倍以上": pop.le(3) & e["ratio"].ge(1.1),
        "1〜3番人気・REIN/市場0.9倍未満（逆）": pop.le(3) & e["ratio"].lt(0.9),
    }


def evaluate(e: pd.DataFrame) -> dict:
    from baken_academia.market_stack import day_bootstrap  # noqa: E402

    e = e.copy()
    e["year"] = e["race_date"].dt.year
    e["band"] = pd.cut(e["win_odds"], BANDS, labels=BAND_LABELS, right=False)
    fp = pd.to_numeric(e["finish_position"], errors="coerce")
    e["win_ret"] = np.where(fp.eq(1), e["win_odds"] * 100, 0.0)
    e["top3"] = fp.between(1, 3).astype(float)
    base = e.groupby(["year", "band"], observed=True)[["win_ret", "top3"]].transform("mean")
    e["x_win"] = e["win_ret"] - base["win_ret"]
    e["x_top3"] = 100 * (e["top3"] - base["top3"])
    e["role_rank"] = e.groupby("race_id")["p_role"].rank(ascending=False, method="first")
    e["ratio"] = e["p_rein"] / e["p_market"]
    sel = selections(e)
    races_by_year = e.groupby("year")["race_id"].nunique()
    rows = {}
    for name, mask in sel.items():
        s = e.loc[mask]
        per_year = {}
        for year, g in s.groupby("year"):
            per_year[int(year)] = {
                "horses": int(len(g)), "per_race": float(len(g) / races_by_year[year]),
                "avg_odds": float(g["win_odds"].median()),
                "win_roi": float(g["win_ret"].mean()), "x_win": float(g["x_win"].mean()),
                "top3_rate": float(100 * g["top3"].mean()), "x_top3": float(g["x_top3"].mean()),
            }
        rows[name] = {
            "horses": int(len(s)), "per_race": float(len(s) / e["race_id"].nunique()),
            "win_roi": float(s["win_ret"].mean()), "top3_rate": float(100 * s["top3"].mean()),
            "x_win": day_bootstrap(s["x_win"], s["race_date"]),
            "x_top3": day_bootstrap(s["x_top3"], s["race_date"]),
            "years_x_win_positive": int(sum(v["x_win"] > 0 for v in per_year.values())),
            "years_x_top3_positive": int(sum(v["x_top3"] > 0 for v in per_year.values())),
            "per_year": per_year,
        }
    pool = e.loc[pd.to_numeric(e["popularity"], errors="coerce").ge(4)].copy()
    pool["decile"] = pool.groupby("year")["ratio"].transform(lambda r: pd.qcut(r.rank(method="first"), 10, labels=False) + 1)
    deciles = {}
    for d, g in pool.groupby("decile"):
        deciles[int(d)] = {
            "horses": int(len(g)), "ratio_median": float(g["ratio"].median()),
            "win_roi": float(g["win_ret"].mean()), "x_win": float(g["x_win"].mean()),
            "x_top3": float(g["x_top3"].mean()),
            "years_x_top3_positive": int(sum(g.groupby("year")["x_top3"].mean().gt(0))),
        }
    log_loss = {}
    y = fp.eq(1).astype(float)
    for col in ("p_role", "p_market", "p_rein"):
        p = e[col].clip(1e-6, 1 - 1e-6)
        log_loss[col] = float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    return {
        "races": int(e["race_id"].nunique()), "horses": int(len(e)),
        "years": {int(k): int(v) for k, v in races_by_year.items()},
        "log_loss": log_loss, "selections": rows, "ratio_deciles_popularity4plus": deciles,
    }


def summary_markdown(r: dict) -> str:
    lines = ["# REIN gap research", "",
             f"Out-of-sample JRA flat races: {r['races']:,} ({', '.join(f'{y}: {n:,}' for y, n in r['years'].items())})", "",
             "Log loss: " + ", ".join(f"{k} {v:.5f}" for k, v in r["log_loss"].items()), "",
             "| selection | horses | per race | win ROI | x_win (95%) | top3 | x_top3 pt (95%) | years x_top3>0 |",
             "| --- | ---: | ---: | ---: | --- | ---: | --- | ---: |"]
    n_years = len(r["years"])
    for name, s in r["selections"].items():
        xw, xt = s["x_win"], s["x_top3"]
        lines.append(f"| {name} | {s['horses']:,} | {s['per_race']:.2f} | {s['win_roi']:.1f} | "
                     f"{xw['mean']:+.1f} ({xw['low']:+.1f}, {xw['high']:+.1f}) | {s['top3_rate']:.1f} | "
                     f"{xt['mean']:+.2f} ({xt['low']:+.2f}, {xt['high']:+.2f}) | {s['years_x_top3_positive']}/{n_years} |")
    lines += ["", "## Per year (x_win / x_top3)", "", "| selection | " + " | ".join(str(y) for y in r["years"]) + " |",
              "| --- | " + " | ".join("---" for _ in r["years"]) + " |"]
    for name, s in r["selections"].items():
        cells = [f"{s['per_year'].get(y, {}).get('x_win', float('nan')):+.1f} / {s['per_year'].get(y, {}).get('x_top3', float('nan')):+.2f}"
                 for y in r["years"]]
        lines.append(f"| {name} | " + " | ".join(cells) + " |")
    lines += ["", "## REIN/market ratio deciles (4番人気以下)", "",
              "| decile | horses | ratio | win ROI | x_win | x_top3 pt | years x_top3>0 |", "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for d, s in r["ratio_deciles_popularity4plus"].items():
        lines.append(f"| {d} | {s['horses']:,} | {s['ratio_median']:.2f} | {s['win_roi']:.1f} | {s['x_win']:+.1f} | {s['x_top3']:+.2f} | {s['years_x_top3_positive']}/{n_years} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    raw = pd.read_parquet(os.environ.get("REIN_HISTORY_PATH", "data/raw/jra/races-2019-2026.parquet"))
    raw["race_id"] = raw["race_id"].astype(str)
    odds = load_odds(Path(os.environ.get("REIN_GAP_ODDS", ".odds")))
    print(f"[odds] rows={len(odds):,}", flush=True)
    e = build_frame(raw, odds)
    report = evaluate(e)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=float))
    summary = summary_markdown(report)
    (OUT / "summary.md").write_text(summary)
    print(summary, flush=True)


if __name__ == "__main__":
    main()
