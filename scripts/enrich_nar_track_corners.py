"""Restore missing passing orders from official results, at >=3s per request.

Only matching horse IDs and horse numbers are updated; results are never changed.
Checkpoints survive individual HTTP failures and are uploaded by the workflow.
"""
import argparse
import asyncio
import gzip
import hashlib
import json
import re
from pathlib import Path

import pandas as pd

from baken_academia.nar_backfill import PoliteNarClient, parse_result_page


def is_maintenance(payload):
    return 'システムメンテナンス' in payload.decode('utf-8-sig', errors='replace')


def archive_unavailable_cache(cache_dir, url):
    digest = hashlib.sha256(url.encode()).hexdigest()
    path = cache_dir / digest[:2] / f'{digest}.html.gz'
    if not path.exists():
        return
    raw = gzip.decompress(path.read_bytes())
    try:
        valid = bool(parse_result_page(raw, url))
    except ValueError:
        valid = False
    if not valid:
        backup = path.with_name(f'{digest}.unavailable-{hashlib.sha256(raw).hexdigest()[:12]}.html.gz')
        if backup.exists():
            path.unlink()
        else:
            path.rename(backup)


def merge_corners(frame, records):
    updated = frame.copy()
    lookup = {int(r["horse_number"]): r for r in records}
    count = 0
    for index, row in updated.iterrows():
        source = lookup.get(int(row.horse_number))
        if not source or str(source["horse_id"]) != str(row.horse_id):
            continue
        if source["race_date"] != row.race_date or int(source["race_no"]) != int(row.race_no):
            continue
        value = source.get("corner_positions")
        if isinstance(value, str) and re.fullmatch(r"\d{1,2}(?:-\d{1,2}){1,3}", value):
            updated.at[index, "corner_positions"] = value
            count += 1
    return updated, count


async def run(args):
    original = pd.read_parquet(args.input)
    # A previous joined research artifact includes measurement columns: retain
    # only the original result schema before re-running an exact-date join.
    end = original.columns.get_loc("prior_style") if "prior_style" in original else len(original.columns)
    data = original.iloc[:, :end].rename(columns={"source_url_x": "source_url"}).copy()
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint = args.output / "results" / "nar-kochi-enriched.parquet"
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    if checkpoint.exists():
        saved = pd.read_parquet(checkpoint)
        if len(saved) != len(data) or set(saved.race_id) != set(data.race_id):
            raise ValueError("Checkpoint does not match source artifact")
        data = saved
    races = data.groupby("race_id", sort=False).first().sort_values(["race_date", "race_no"])
    if args.limit:
        races = races.tail(args.limit)
    log = []
    consecutive_errors = 0
    async with PoliteNarClient(args.output / "raw-results", 3, 3) as client:
        for number, (rid, race) in enumerate(races.iterrows(), 1):
            mask = data.race_id.eq(rid)
            maintenance = False
            try:
                archive_unavailable_cache(client.cache_dir, race.source_url)
                raw = await client.fetch(race.source_url)
                if is_maintenance(raw):
                    maintenance = True
                    raise RuntimeError('Official NAR site is under system maintenance; checkpoint saved without further requests')
                records = parse_result_page(raw, race.source_url)
                updated, count = merge_corners(data.loc[mask], records)
                data.loc[mask, "corner_positions"] = updated.corner_positions
                log.append({"race_id": rid, "source_url": race.source_url, "updated": count, "status": "fetched"})
                consecutive_errors = 0
            except Exception as error:
                log.append({"race_id": rid, "source_url": race.source_url, "status": "error", "error": str(error)})
                consecutive_errors += 1
            stop = maintenance or consecutive_errors >= 3
            if number % 25 == 0 or number == len(races) or stop:
                data.to_parquet(checkpoint, index=False)
                (args.output / "corner-collection.json").write_text(json.dumps({"planned_races": len(races), "completed_races": number, "pilot": bool(args.limit), "records": log}, ensure_ascii=False, indent=2))
                print(f"{number}/{len(races)} races; updated {sum(r.get('updated', 0) for r in log)} passing orders; errors {sum(r['status']=='error' for r in log)}", flush=True)
            if stop:
                reason = 'official site maintenance' if maintenance else 'three consecutive source errors'
                print(f'Stopped due to {reason}; checkpoint retained. No further requests.', flush=True)
                break
    if not any(r.get("updated", 0) for r in log):
        raise RuntimeError("No matching official passing orders restored")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--limit", type=int, default=0)
    asyncio.run(run(p.parse_args()))
