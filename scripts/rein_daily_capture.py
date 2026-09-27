"""Capture one finished race day, reusing the audited historical parsers.

Archives contain raw pages, normalized results, final odds, payouts and audit JSON.
No model training or user data belongs in this job. Completion is written only
when all selected source requests and coverage checks have succeeded.
"""
from __future__ import annotations
import argparse
import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from baken_academia import jra_backfill, nar_backfill, jra_all_odds_backfill


def capture_date(value: str | None, now: datetime | None = None) -> date:
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(timezone(timedelta(hours=9)))
    target = date.fromisoformat(value) if value else local.date() - timedelta(days=local.hour < 22)
    if not local.date() - timedelta(days=7) <= target <= local.date():
        raise ValueError("Daily capture date must be within the last seven days")
    if target == local.date() and local.hour < 22:
        raise ValueError("Today's final data is captured after 22:00 JST")
    return target


async def capture(kind: str, target: date, directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "races.parquet"
    common = dict(work_dir=directory / "raw", output=output, min_delay=3.0, max_delay=4.0,
                  permission_confirmed=True, continue_on_error=False, allow_empty=True)
    if kind == "nar":
        result = await nar_backfill.backfill(argparse.Namespace(**common, year=target.year, month=target.month,
                                                              start_day=target.day, end_day=target.day, max_races=None))
        if result.get("errors") or result.get("odds_errors"):
            raise ValueError("Incomplete NAR capture")
        if result.get("races") and result["odds_pages"] != result["races"] * len(nar_backfill.ODDS_ENDPOINTS):
            raise ValueError("Missing NAR odds pages")
    else:
        result = await jra_backfill.backfill(argparse.Namespace(**common, start_date=str(target), end_date=str(target), max_events=None))
        if result.get("errors"):
            raise ValueError("Incomplete JRA capture")
        if result.get("races"):
            odds = await jra_all_odds_backfill.backfill(argparse.Namespace(
                input=output, start_date=str(target), end_date=str(target), work_dir=directory / "odds-raw",
                output_dir=directory / "odds", min_delay=3.0, max_delay=4.0,
                permission_confirmed=True, continue_on_error=False))
            if odds.get("errors") or odds["pages_by_bet_type"].get("win_place", 0) != result["races"]:
                raise ValueError("Missing JRA win/place pages")
            result["odds"] = odds
    summary = {"capture_schema": 2, "dataset": kind, "date": str(target), "status": result.get("status", "complete"),
               "captured_at": datetime.now(timezone.utc).isoformat(), "result": result}
    (directory / "complete.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=["jra", "nar"], required=True)
    parser.add_argument("--date")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(capture(args.dataset, capture_date(args.date), args.output_dir))

if __name__ == "__main__":
    main()
