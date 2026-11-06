"""Freeze the market stacker for shadow operation (research only).

Nothing here changes the deployed model, tickets or web app.

1. Production-equivalent role models (rein-role-v4 settings) are trained
   through 2024, so their 2025-2026 probabilities are out of sample, as the
   live model's are on future races.
2. One conditional-logit stacker per role (market and REIN role log
   probabilities, no race context, l2 = 1; the simplest setting that passed
   in v7 and v9) is fit on 2025 and audited on 2026 against the production
   70/30 rule with the web app's caps.
3. The coefficients refit on 2025-2026 are printed as REIN_STACK_JSON and
   become rein-web/lib/market-stack-v1.json for the shadow comparison.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))
from rein_v7_research import build_designs  # noqa: E402
from rein_v8_research import lgb_model  # noqa: E402

from baken_academia.market_stack import (  # noqa: E402
    ROLES, ConditionalLogit, day_bootstrap, market_probability, normalize_within, role_log_loss, stack_features,
)
from baken_academia.ticket_search import WEB_CAPS, RaceArrays, evaluate_hits, pad_races  # noqa: E402

OUT = Path(os.environ.get("REIN_STACK_OUTPUT", "reports/rein-stack-export"))
TRAIN_END = "2025-01-01"
POSITIONS = {"first": 1, "second": 2, "third": 3}
L2 = 1.0
LABELS = {"win": "単勝", "place": "複勝", "bracket_quinella": "枠連", "quinella": "馬連",
          "wide": "ワイド", "exacta": "馬単", "trio": "3連複"}


def oos_frame(raw: pd.DataFrame) -> pd.DataFrame:
    x, designs = build_designs(raw, None)
    flat = x["surface"].isin(["芝", "ダート"])
    train = x["race_date"].lt(TRAIN_END) & flat
    target = x["race_date"].ge(TRAIN_END) & flat
    probs = pd.DataFrame(index=x.index[target])
    for role, frame in designs["v4"].items():
        y = pd.to_numeric(x["finish_position"], errors="coerce").eq(POSITIONS[role])
        print(f"[model] production-equivalent {role}", flush=True)
        model = lgb_model(POSITIONS[role]).fit(frame.loc[train], y.loc[train])
        probs[f"{role}_probability"] = model.predict_proba(frame.loc[target])[:, 1]
    columns = ["race_id", "race_date", "horse_number", "gate", "popularity", "finish_position"]
    e = pd.concat([x.loc[probs.index, columns], probs], axis=1).dropna(subset=["horse_number", "gate"])
    e["race_id"] = e["race_id"].astype(str)
    e = e.sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    e = e.loc[e.groupby("race_id")["race_id"].transform("size").ge(4)].reset_index(drop=True)
    e["market_probability"] = market_probability(e["popularity"], e["race_id"])
    e["year"] = e["race_date"].dt.year
    for role, position in POSITIONS.items():
        e[f"is_{role}"] = pd.to_numeric(e["finish_position"], errors="coerce").eq(position).astype(int)
    return e


def fit(e: pd.DataFrame, rows: pd.Series) -> dict[str, ConditionalLogit]:
    models = {}
    for role in ROLES:
        f = stack_features(e, role, False)
        models[role] = ConditionalLogit(l2=L2).fit(f.loc[rows], e.loc[rows, "race_id"], e.loc[rows, f"is_{role}"])
    return models


def predict(e: pd.DataFrame, models: dict[str, ConditionalLogit]) -> pd.DataFrame:
    return pd.DataFrame({role: models[role].predict(stack_features(e, role, False), e["race_id"])
                         for role in ROLES}, index=e.index)


def hits(e: pd.DataFrame, roles: pd.DataFrame) -> dict[str, pd.Series]:
    frame = e.assign(**{f"r_{k}": roles[k].to_numpy() for k in ROLES})
    ids, mask, a = pad_races(frame, {"gate": "gate", "finish": "finish_position",
                                     **{f"r_{k}": f"r_{k}" for k in ROLES}})
    field = frame.groupby("race_id", sort=False).size().reindex(ids).to_numpy()
    races = RaceArrays(mask, a["gate"].astype(int), a["finish"].astype(int), field)
    stacked = np.stack([a[f"r_{k}"] for k in ROLES], axis=2)
    out = evaluate_hits(races, stacked, support=9, caps=WEB_CAPS, same_gate_bracket=False)
    return {bet: pd.Series(v, index=ids) for bet, v in out.items()}


def main() -> None:
    raw = pd.read_parquet(os.environ.get("REIN_HISTORY_PATH", "data/raw/jra/races-2019-2026.parquet"))
    raw["race_id"] = raw["race_id"].astype(str)
    e = oos_frame(raw)
    production = pd.DataFrame({role: .7 * e["market_probability"] + .3 * normalize_within(e[f"{role}_probability"], e["race_id"])
                               for role in ROLES}, index=e.index)
    audit = e["year"].ge(2026)
    stack = predict(e, fit(e, e["year"].eq(2025)))
    race_date = e.groupby("race_id")["race_date"].first()
    race_year = e.groupby("race_id")["year"].first()
    base_hits, stack_hits = hits(e, production), hits(e, stack)
    report = {"scope": "Research only: stacker fit on 2025 (v4 trained through 2024), audited on 2026 with web caps.",
              "l2": L2, "context": False, "tickets": {}, "log_loss": {}}
    for year in (2025, 2026):
        rows = e["year"].eq(year)
        report["log_loss"][str(year)] = {role: {
            "production": role_log_loss(production.loc[rows, role], e.loc[rows, f"is_{role}"], e.loc[rows, "race_id"]),
            "stack": role_log_loss(stack.loc[rows, role], e.loc[rows, f"is_{role}"], e.loc[rows, "race_id"]),
        } for role in ROLES}
        ids = race_year.index[race_year.eq(year)]
        report["tickets"][str(year)] = {}
        for bet in base_hits:
            b, s = base_hits[bet].reindex(ids), stack_hits[bet].reindex(ids)
            ok = b.notna() & s.notna()
            report["tickets"][str(year)][bet] = {
                "races": int(ok.sum()), "production": float(b[ok].mean()), "stack": float(s[ok].mean()),
                "change": day_bootstrap(s[ok] - b[ok], race_date.reindex(ok.index[ok])),
            }
    report["decision"] = {bet: "pass" if all(report["tickets"][y][bet]["change"]["low"] > 0 for y in ("2025", "2026")) else "hold"
                          for bet in base_hits}
    final = fit(e, e["year"].ge(2025))
    report["export"] = {
        "version": "market-stack-v1",
        "fit": {"from": str(e["race_date"].min().date()), "to": str(e["race_date"].max().date()),
                "races": int(e["race_id"].nunique()), "role_model": "rein-role-v4 settings trained through 2024"},
        "features": "log_market, log_role, log_market_sq, log_<other roles>; softmax within race",
        "coefficients": {role: final[role].coefficients() for role in ROLES},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=float))
    lines = ["## 市場合成の固定（影運用用）", "", "2025年で学習、2026年で確認（Web版の点数で採点、ポイント）", "",
             "|券種|2025 現行→合成|2025の差|2026 現行→合成|2026の差|採否|", "|---|---|---|---|---|---|"]
    for bet in base_hits:
        cells = []
        for y in ("2025", "2026"):
            t = report["tickets"][y][bet]
            c = t["change"]
            cells += [f"{t['production']:.2%}→{t['stack']:.2%}", f"{100*c['mean']:+.2f} [{100*c['low']:+.2f}, {100*c['high']:+.2f}]"]
        lines.append(f"|{LABELS[bet]}|" + "|".join(cells) + f"|{report['decision'][bet]}|")
    (OUT / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("REIN_STACK_JSON_BEGIN")
    print(json.dumps({"tickets": report["tickets"], "log_loss": report["log_loss"], "decision": report["decision"],
                      "export": report["export"]}, ensure_ascii=False, default=float))
    print("REIN_STACK_JSON_END")


if __name__ == "__main__":
    main()
