"""Build deterministic JRA collection windows; Supabase is the resume source of truth."""
import csv
import json
import os
from datetime import date, timedelta


def periods(race_dates=None):
    result = []
    start, last = date(2019, 1, 1), date(2026, 9, 18)
    while start <= last:
        end = min(start + timedelta(days=13), last)
        name = f"{start:%Y%m%d}-{end:%Y%m%d}"
        has_races = race_dates is None or any(start <= day <= end for day in race_dates)
        if has_races:
            result.append(dict(name=name, start=start.isoformat(), end=end.isoformat()))
        start = end + timedelta(days=1)
    return result


def main():
    with open("data/indices/jra-race-pages-2019-2026.csv") as source:
        race_dates = {date.fromisoformat(row["race_date"]) for row in csv.DictReader(source)}
    planned = periods(race_dates)
    print(f"Planned {len(planned)} JRA periods; completed periods are skipped by Supabase preflight checks")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("periods=" + json.dumps({"include": planned}, separators=(",", ":")) + "\n")
        output.write(f"count={len(planned)}\n")


if __name__ == "__main__":
    main()
