"""Shadow comparison of the frozen market stacker against production tickets.

Usage:
  python scripts/rein_shadow_report.py sql --from 2026-10-01 --to 2026-11-30 > shadow.sql
      Prints one read-only query for the Supabase database (run it as is).
  python scripts/rein_shadow_report.py summary rows.json [--start 2026-11-07]
      Turns the query's rows (a JSON array) into a Markdown table with
      day-cluster bootstrap 95% intervals.  Races before ``--start`` are
      reported separately as the look-back on predictions saved before the
      stacker was frozen; they are still pre-start, so neither part uses
      anything known after the off.

Nothing here writes to the database or changes the web app.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from baken_academia.shadow_tickets import WEB_CAPS, report_sql  # noqa: E402

COEFFICIENTS = ROOT / "rein-web" / "lib" / "market-stack-v1.json"
LABELS = {"三連複": "3連複"}


def _bootstrap(columns: dict[str, np.ndarray], stat, draws: int = 4000, seed: int = 20261106):
    """Point value and 95% interval of ``stat`` over day-resampled column sums."""
    n = len(next(iter(columns.values())))
    point = stat({k: v.sum() for k, v in columns.items()})
    rng = np.random.default_rng(seed)
    pick = rng.integers(0, n, size=(draws, n))
    sims = stat({k: v[pick].sum(axis=1) for k, v in columns.items()})
    return float(point), float(np.quantile(sims, .025)), float(np.quantile(sims, .975))


def summarize(rows: list[dict], start: str | None = None) -> str:
    parity = {r["bet"]: (r["points_production"], r["races"]) for r in rows if r["kind"] == "parity"}
    days = [r for r in rows if r["kind"] == "day"]
    parts = [("影運用（係数固定後）", [d for d in days if not start or d["day"] >= start])]
    if start:
        parts.append(("振り返り（固定前に保存した発走前予想）", [d for d in days if d["day"] < start]))
    lines = []
    for title, part in parts:
        if not part:
            continue
        span = f"{min(d['day'] for d in part)}〜{max(d['day'] for d in part)}"
        lines += [f"### {title}：{span}", "",
                  "|券種|レース|的中率 現行→影|差（95%区間）|回収率 現行→影|回収率の差（95%区間）|",
                  "|---|---:|---|---|---|---|"]
        for bet in WEB_CAPS:
            ds = [d for d in part if d["bet"] == bet]
            races = sum(d["races"] for d in ds)
            if not races:
                continue
            col = {k: np.array([d[k] for d in ds], float) for k in (
                "races", "hits_production", "hits_shadow", "points_production", "points_shadow",
                "return_production", "return_shadow")}
            hit = _bootstrap(col, lambda c: (c["hits_shadow"] - c["hits_production"]) / c["races"])
            ret = _bootstrap(col, lambda c: c["return_shadow"] / (100 * c["points_shadow"])
                             - c["return_production"] / (100 * c["points_production"]))
            hp, hs = col["hits_production"].sum() / races, col["hits_shadow"].sum() / races
            rp = col["return_production"].sum() / (100 * col["points_production"].sum())
            rs = col["return_shadow"].sum() / (100 * col["points_shadow"].sum())
            lines.append(f"|{LABELS.get(bet, bet)}|{races}|{hp:.1%}→{hs:.1%}"
                         f"|{100 * hit[0]:+.1f} [{100 * hit[1]:+.1f}, {100 * hit[2]:+.1f}]"
                         f"|{rp:.1%}→{rs:.1%}|{100 * ret[0]:+.1f} [{100 * ret[1]:+.1f}, {100 * ret[2]:+.1f}]|")
        lines.append("")
    bad = {LABELS.get(b, b): m for b, (m, _) in parity.items() if m}
    lines.append("本番の保存済み買い目との一致: " + ("すべて一致" if not bad else
                 "不一致あり " + "、".join(f"{b} {m}R" for b, m in bad.items())))
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    q = sub.add_parser("sql")
    q.add_argument("--from", dest="date_from", required=True)
    q.add_argument("--to", dest="date_to", required=True)
    q.add_argument("--coefficients", default=str(COEFFICIENTS))
    s = sub.add_parser("summary")
    s.add_argument("rows")
    s.add_argument("--start")
    args = parser.parse_args()
    if args.command == "sql":
        frozen = json.loads(Path(args.coefficients).read_text())
        print(report_sql(frozen["coefficients"], args.date_from, args.date_to))
    else:
        print(summarize(json.loads(Path(args.rows).read_text()), args.start))


if __name__ == "__main__":
    main()
