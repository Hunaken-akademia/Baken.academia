from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

from .jra_all_payouts import parse_all_payouts


def _write_gzip(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wb") as stream:
        stream.write(payload)
    temporary.replace(path)


async def backfill(args: argparse.Namespace) -> dict[str, object]:
    from .jra_backfill import PoliteJraClient

    if not args.permission_confirmed:
        raise ValueError("JRAの許可確認後、--permission-confirmed を付けてください")

    start, end = date.fromisoformat(args.start_date), date.fromisoformat(args.end_date)
    source = pd.read_parquet(args.input)
    source["race_date"] = pd.to_datetime(source["race_date"])
    selected = source.loc[source["race_date"].dt.date.between(start, end)].copy()
    if selected.empty:
        raise ValueError("指定期間のJRAレースがありません")

    pages = selected["source_cname"].dropna().astype(str).drop_duplicates().sort_values().tolist()
    expected_races = int(selected["race_id"].nunique())
    payout_rows: list[dict[str, object]] = []
    errors: list[dict[str, str]] = []

    async with PoliteJraClient(args.work_dir / "http-cache", args.min_delay, args.max_delay) as client:
        for index, result_cname in enumerate(pages, 1):
            try:
                payload = await client.fetch(result_cname)
                raw_path = args.work_dir / "pages" / str(start.year) / (
                    hashlib.sha256(result_cname.encode()).hexdigest() + ".html.gz"
                )
                if not raw_path.exists():
                    _write_gzip(raw_path, payload)
                rows = parse_all_payouts(payload, result_cname)
                payout_rows.extend(
                    row for row in rows
                    if start <= date.fromisoformat(str(row["race_date"])) <= end
                )
            except Exception as exc:
                errors.append({"result_cname": result_cname, "error": str(exc)})
                if not args.continue_on_error:
                    raise
            if index == 1 or index % 20 == 0 or index == len(pages):
                print(json.dumps({
                    "result_pages": f"{index}/{len(pages)}",
                    "payout_rows": len(payout_rows),
                    "network_requests": client.stats.network_requests,
                    "errors": len(errors),
                }, ensure_ascii=False), flush=True)

    if not payout_rows:
        raise ValueError("保存できたJRA払戻データがありません")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    payouts = pd.DataFrame(payout_rows).drop_duplicates(
        ["race_id", "bet_type", "selection_1", "selection_2", "selection_3"]
    )
    payouts.to_parquet(args.output_dir / "payouts.parquet", index=False)
    payout_races = int(payouts["race_id"].nunique())
    counts = payouts.groupby("bet_type").size().to_dict()
    report = {
        "source": "JRA公式・全通常馬券払戻",
        "start_date": args.start_date,
        "end_date": args.end_date,
        "result_pages": len(pages),
        "expected_races": expected_races,
        "payout_races": payout_races,
        "payout_rows": len(payouts),
        "rows_by_bet_type": {str(key): int(value) for key, value in counts.items()},
        "network_requests": client.stats.network_requests,
        "errors": errors,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (args.output_dir / "audit.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA公式の全通常馬券払戻を低負荷で取得します")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("data/raw/jra-payouts"))
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=4.0)
    parser.add_argument("--permission-confirmed", action="store_true")
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(backfill(args)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
