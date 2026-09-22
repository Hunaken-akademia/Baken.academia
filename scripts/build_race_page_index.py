"""Build the minimal, durable public race-page input for odds backfills."""
import argparse
from pathlib import Path
import pandas as pd


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    frame = pd.read_parquet(args.source, columns=["race_date", "source_cname"])
    frame["race_date"] = pd.to_datetime(frame["race_date"]).dt.strftime("%Y-%m-%d")
    frame = frame.dropna().drop_duplicates().sort_values(["race_date", "source_cname"])
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(output, index=False)
    print(f"Saved {len(frame)} unique race pages ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
