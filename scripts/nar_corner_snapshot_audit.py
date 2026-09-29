"""Audit genuine prestart NAR maps without reconstructing historical forecasts.

Input: narrowly exported server prestart snapshots. Only public result pages are
fetched, with the existing collector's three-second minimum interval. No model
is fitted on this small two-day sample.
"""
import argparse
import asyncio
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from baken_academia.nar_backfill import PoliteNarClient, parse_result_page
from baken_academia.nar_corners import unambiguous_ranks


def sequence(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{1,2}(?:-\d{1,2}){1,3}", value):
        return []
    values = list(map(int, value.split("-")))
    return values if all(1 <= n <= 18 for n in values) else []


def stage_position(values, stage):
    index = 0 if stage == 0 else stage - (5 - len(values))
    return values[index] if 2 <= len(values) <= 4 and 0 <= index < len(values) else None


def estimate(history, stage, field):
    observations = [(stage_position(values, stage), 5-i) for i, values in enumerate(history[:5])]
    observations = [(v, w) for v, w in observations if v is not None]
    if not observations:
        return None
    weighted = min(field, max(1, sum(v*w for v, w in observations)/sum(w for _, w in observations)))
    return weighted, min(field, max(1, observations[0][0]))


async def run(args):
    snapshots = json.loads(args.snapshots.read_text())
    records, coverage = [], []
    async with PoliteNarClient(args.cache_dir, 3, 4) as client:
        for snapshot in snapshots:
            rid, forecast = snapshot["race_id"], snapshot["forecast"]
            if rid[8:10] == "03":
                coverage.append({"race": rid, "status": "banei-excluded"})
                continue
            generated = datetime.fromisoformat(snapshot["generated_at"])
            starts = datetime.fromisoformat(snapshot["starts_at"])
            if generated >= starts or starts > datetime.now(timezone.utc):
                coverage.append({"race": rid, "status": "not-eligible"})
                continue
            date = snapshot["race_date"]
            url = f"https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_raceDate={date.replace('-', '%2F')}&k_babaCode={int(rid[8:10])}&k_raceNo={int(rid[10:12])}"
            try:
                rows = parse_result_page(await client.fetch(url), url)
                if not rows or not any(row["finish_position"] == 1 for row in rows):
                    coverage.append({"race": rid, "status": "result-pending"})
                    continue
                if any(row["race_date"] != date or int(row["race_no"]) != int(rid[10:12]) for row in rows):
                    raise ValueError("Result identity mismatch")
                actual = {row["horse_number"]: row for row in rows}
                passages = {}
                for passage in json.loads(rows[0].get("corner_passages") or "[]"):
                    match = re.search(r"([1-4])(?:コーナー|角)", unicodedata.normalize("NFKC", passage["label"]))
                    if match:
                        passages[int(match.group(1))] = unambiguous_ranks(passage["order"])
                if passages:
                    passages[0] = passages[min(passages)]
                runners = forecast["horses"]
                before = len(records)
                for horse in runners:
                    row = actual.get(horse["number"])
                    if not row:
                        continue
                    outcome = sequence(row.get("corner_positions"))
                    history = [s for value in (horse.get("mapPositions") or []) if (s := sequence(value))][:5]
                    for stage in (0, 3, 4):
                        observed = stage_position(outcome, stage)
                        if observed is None:
                            observed = passages.get(stage, {}).get(horse["number"])
                        predicted = estimate(history, stage, len(runners))
                        if observed is None or predicted is None:
                            continue
                        point, previous = predicted
                        records.append({"race": rid, "date": date, "venue": forecast["title"].split()[0], "stage": stage,
                                        "error": abs(point-observed), "previousError": abs(previous-observed),
                                        "bias": point-observed})
                coverage.append({"race": rid, "status": "audited" if len(records)>before else "no-paired-observations"})
                print(f"Audited {rid}, paired observations {len(records)}", flush=True)
            except Exception as exc:
                coverage.append({"race": rid, "status": "error", "error": str(exc)[:160]})
                print(f"Could not audit {rid}: {exc}", flush=True)
    df = pd.DataFrame(records)
    def summarize(group):
        return {"races": int(group.race.nunique()), "horses": len(group), "mae": round(float(group.error.mean()), 4),
                "previousMae": round(float(group.previousError.mean()), 4), "bias": round(float(group.bias.mean()), 4),
                "within2": round(float(group.error.le(2).mean()), 4)}
    result = {"version": "nar-prestart-corner-audit-v1", "period": "2026-09-28–2026-09-29", "status": "limited-forward-audit",
              "note": "サーバーに発走前保存された近走通過順だけを使用。当日の個別通過順が空欄の場合は全馬通過順の単独馬のみ照合し、括弧内の集団は順位不確定のため除外。2日間の限定監査で、場別補正の確定・1〜2角・内外・馬身差・ペースの精度保証には使わない。",
              "coverage": coverage, "overall": {str(stage): summarize(g) for stage, g in df.groupby("stage")} if len(df) else {},
              "byVenue": [{"venue": venue, "stage": int(stage), **summarize(g)} for (venue, stage), g in df.groupby(["venue", "stage"])] if len(df) else []}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"overall": result["overall"], "coverage": pd.Series([r["status"] for r in coverage]).value_counts().to_dict()}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshots", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
