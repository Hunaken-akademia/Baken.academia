"""Build deterministic NAR half-month windows; Supabase is the resume source of truth."""
import calendar
import json
import os


def key(year, month, start_day, end_day):
    return f"{year:04d}{month:02d}{start_day:02d}-{year:04d}{month:02d}{end_day:02d}"


def build_periods():
    periods = []
    for year in range(2019, 2027):
        last_month = 9 if year == 2026 else 12
        for month in range(1, last_month + 1):
            last_day = calendar.monthrange(year, month)[1]
            for start_day, end_day, suffix in ((1, 15, "a"), (16, last_day, "b")):
                periods.append({
                    "year": year,
                    "month": month,
                    "month_padded": f"{month:02d}",
                    "start_day": start_day,
                    "end_day": end_day,
                    "suffix": suffix,
                    "period": key(year, month, start_day, end_day),
                })
    return periods


def main():
    planned = build_periods()
    print(f"Planned {len(planned)} NAR half-month periods; completed periods are skipped by Supabase preflight checks")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("matrix=" + json.dumps({"include": planned}, separators=(",", ":")) + "\n")
        output.write(f"count={len(planned)}\n")


if __name__ == "__main__":
    main()
