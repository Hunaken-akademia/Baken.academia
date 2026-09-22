"""Skip successful collection windows, including the pre-billing backfill."""
import csv
import json
import os
import re
from datetime import date, timedelta
from urllib.request import Request, urlopen

JOB = re.compile(r"^collect \((\d{8}-\d{8})(?:,|\))")


def get(path):
    request = Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/{path}",
        headers={"Authorization": f"Bearer {os.environ['GH_TOKEN']}",
                 "Accept": "application/vnd.github+json"},
    )
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def periods(completed, race_dates=None):
    result = []
    start, last = date(2019, 1, 1), date(2026, 9, 18)
    while start <= last:
        end = min(start + timedelta(days=13), last)
        name = f"{start:%Y%m%d}-{end:%Y%m%d}"
        has_races = race_dates is None or any(start <= day <= end for day in race_dates)
        if name not in completed and has_races:
            result.append(dict(name=name, start=start.isoformat(), end=end.isoformat()))
        start = end + timedelta(days=1)
    return result


def main():
    runs = get("actions/workflows/jra-all-odds-backfill.yml/runs?per_page=100")
    run_ids = {35499112151} | {r["id"] for r in runs["workflow_runs"]}
    completed = set()
    for run_id in sorted(run_ids):
        page = 1
        while True:
            jobs = get(f"actions/runs/{run_id}/jobs?filter=all&per_page=100&page={page}")["jobs"]
            for job in jobs:
                match = JOB.match(job["name"])
                if match and job["conclusion"] == "success":
                    completed.add(match[1])
            if len(jobs) < 100:
                break
            page += 1
    with open("data/indices/jra-race-pages-2019-2026.csv") as source:
        race_dates = {date.fromisoformat(row["race_date"]) for row in csv.DictReader(source)}
    pending = periods(completed, race_dates)
    print(f"Skipping {len(completed)} successful periods; collecting {len(pending)} remaining")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("periods=" + json.dumps(pending, separators=(",", ":")) + "\n")
        output.write(f"count={len(pending)}\n")


if __name__ == "__main__":
    main()
