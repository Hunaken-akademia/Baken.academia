"""Read existing authorized archives, retaining only research years. No uploads."""
import concurrent.futures
import json
from pathlib import Path

from download_recall_archives import build_periods, fetch, post


def download(period):
    path = f"nar/archive/all-bets/v2/{period['year']}/{period['period']}.tar.gz"
    if not post("exists", path).get("exists"):
        return {"period": period["period"], "status": "not-available"}
    fetch(period)
    return {"period": period["period"], "status": "downloaded"}


if __name__ == "__main__":
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for record in pool.map(download, [p for p in build_periods() if p["year"] >= 2024]):
            records.append(record)
            print(json.dumps(record), flush=True)
    out = Path("artifacts/nar-track")
    out.mkdir(parents=True, exist_ok=True)
    (out / "archive-coverage.json").write_text(json.dumps(records, indent=2))
    if not any(r["status"] == "downloaded" for r in records):
        raise RuntimeError("No saved race archives available")
