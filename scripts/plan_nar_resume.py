"""Skip NAR half-month periods whose full archive job already completed successfully."""
import calendar
import json
import os
import re
import time
from datetime import date
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

JOB = re.compile(
    r"^backfill \((\d{4}),\s*(\d{1,2}),\s*\d{2},\s*(\d{1,2}),\s*(\d{1,2}),\s*([ab])\)$"
)


def get(path):
    request = Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/{path}",
        headers={
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
        },
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
        time.sleep(2 ** attempt)


def key(year, month, start_day, end_day):
    return f"{year:04d}{month:02d}{start_day:02d}-{year:04d}{month:02d}{end_day:02d}"


def build_periods(completed):
    periods = []
    for year in range(2019, 2027):
        last_month = 9 if year == 2026 else 12
        for month in range(1, last_month + 1):
            last_day = calendar.monthrange(year, month)[1]
            for start_day, end_day, suffix in ((1, 15, "a"), (16, last_day, "b")):
                period_key = key(year, month, start_day, end_day)
                if period_key in completed:
                    continue
                periods.append({
                    "year": year,
                    "month": month,
                    "month_padded": f"{month:02d}",
                    "start_day": start_day,
                    "end_day": end_day,
                    "suffix": suffix,
                    "period": period_key,
                })
    return periods


def main():
    runs = get("actions/workflows/nar-backfill-8y.yml/runs?per_page=100")
    completed = set()
    for run in runs["workflow_runs"]:
        page = 1
        while True:
            try:
                jobs = get(f"actions/runs/{run['id']}/jobs?filter=all&per_page=100&page={page}")["jobs"]
            except (HTTPError, URLError, TimeoutError) as exc:
                print(f"Skipping temporarily unreadable historical run {run['id']}: {exc}", flush=True)
                break
            for job in jobs:
                match = JOB.match(job["name"])
                if match and job["conclusion"] == "success":
                    year, month, start_day, end_day, _ = match.groups()
                    completed.add(key(int(year), int(month), int(start_day), int(end_day)))
            if len(jobs) < 100:
                break
            page += 1

    pending = build_periods(completed)
    print(f"Skipping {len(completed)} successful NAR half-month periods; collecting {len(pending)} remaining")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("matrix=" + json.dumps({"include": pending}, separators=(",", ":")) + "\n")
        output.write(f"count={len(pending)}\n")


if __name__ == "__main__":
    main()
