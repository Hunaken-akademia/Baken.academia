"""Skip successful collection windows, including the pre-billing backfill."""
import csv
import json
import os
import re
import time
from datetime import date, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

JOB = re.compile(r"^collect \((\d{8}-\d{8})(?:,|\))")


def get(path):
    request = Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/{path}",
        headers={"Authorization": f"Bearer {os.environ['GH_TOKEN']}",
                 "Accept": "application/vnd.github+json"},
    )
    for attempt in range(4):
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
        except (URLError, TimeoutError):
            if attempt == 3:
                raise
        print(f"Temporary GitHub API failure; retry {attempt + 1}/3: {path}", flush=True)
        time.sleep(2 ** attempt)


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
            try:
                jobs = get(f"actions/runs/{run_id}/jobs?filter=all&per_page=100&page={page}")["jobs"]
            except (HTTPError, URLError, TimeoutError) as exc:
                print(f"Skipping temporarily unreadable historical run {run_id}: {exc}", flush=True)
                break
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
