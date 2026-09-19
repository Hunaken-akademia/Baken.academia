from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
from lxml import html



def _text(node) -> str:
    if node is None:
        return ""
    return " ".join(" ".join(node.xpath(".//text()")).split())


def _first(node, xpath: str):
    values = node.xpath(xpath)
    return values[0] if values else None


def _int(value: str | None) -> int | None:
    if value is None:
        return None
    matched = re.search(r"-?\d+", value.replace(",", ""))
    return int(matched.group()) if matched else None


def parse_trifecta_payouts(payload: bytes, source_cname: str) -> list[dict[str, object]]:
    document = html.fromstring(payload.decode("cp932", errors="replace"))
    records: list[dict[str, object]] = []
    for unit in document.xpath("//div[starts-with(@id,'race_result_')]"):
        race_no = _int(unit.get("id"))
        date_line = _text(_first(unit, ".//div[contains(@class,'date_line')]//div[contains(@class,'date')]"))
        date_match = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", date_line)
        course_match = re.search(r"\d+回(.+?)\d+日", date_line)
        if race_no is None or not date_match or not course_match:
            continue
        race_date = date(*(int(part) for part in date_match.groups()))
        race_id = f"{race_date:%Y%m%d}-{course_match.group(1)}-{race_no:02d}"
        for row in unit.xpath(".//tr[contains(normalize-space(.), '3連単')]"):
            row_text = _text(row)
            payout_values = [int(value.replace(",", "")) for value in re.findall(r"([\d,]+)\s*円", row_text)]
            combinations = [
                tuple(map(int, match))
                for match in re.findall(r"(\d{1,2})\s*[→－-]\s*(\d{1,2})\s*[→－-]\s*(\d{1,2})", row_text)
            ]
            if not combinations:
                non_money = re.sub(r"[\d,]+\s*円.*$", "", row_text)
                numbers = [int(value) for value in re.findall(r"(?<!\d)(\d{1,2})(?!\d)", non_money)]
                numbers = [value for value in numbers if 1 <= value <= 18]
                if len(numbers) >= 3:
                    combinations = [tuple(numbers[index:index + 3]) for index in range(0, len(numbers) - 2, 3)]
            for combination, payout in zip(combinations, payout_values, strict=False):
                if len(set(combination)) != 3 or payout <= 0:
                    continue
                records.append(
                    {
                        "race_id": race_id,
                        "race_no": race_no,
                        "first": combination[0],
                        "second": combination[1],
                        "third": combination[2],
                        "payout_yen_per_100": payout,
                        "source": "JRA公式・三連単払戻",
                        "source_cname": source_cname,
                    }
                )
    return records


def _checkpoint(work_dir: Path, cname: str) -> Path:
    digest = hashlib.sha256(cname.encode()).hexdigest()
    return work_dir / "pages" / f"{digest}.jsonl.gz"


async def backfill(args: argparse.Namespace) -> dict[str, object]:
    from .jra_backfill import PoliteJraClient

    if not args.permission_confirmed:
        raise ValueError("JRAの許可確認後、--permission-confirmed を付けてください")
    races = pd.read_parquet(args.input)
    races["race_date"] = pd.to_datetime(races["race_date"])
    start, end = date.fromisoformat(args.start_date), date.fromisoformat(args.end_date)
    selected = races.loc[races["race_date"].dt.date.between(start, end)]
    cnames = selected["source_cname"].dropna().astype(str).drop_duplicates().sort_values().tolist()
    errors: list[dict[str, str]] = []
    paths: list[Path] = []
    async with PoliteJraClient(args.work_dir / "cache", args.min_delay, args.max_delay) as client:
        for index, cname in enumerate(cnames, 1):
            path = _checkpoint(args.work_dir, cname)
            paths.append(path)
            if not path.exists():
                try:
                    payload = await client.fetch(cname)
                    rows = parse_trifecta_payouts(payload, cname)
                    if not rows:
                        raise ValueError("三連単払戻がありません")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with gzip.open(path, "wt", encoding="utf-8") as stream:
                        for row in rows:
                            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                except Exception as exc:
                    errors.append({"source_cname": cname, "error": str(exc)})
                    if not args.continue_on_error:
                        raise
            if index == 1 or index % 20 == 0 or index == len(cnames):
                print(json.dumps({"pages": f"{index}/{len(cnames)}", "errors": len(errors),
                                  "requests": client.stats.network_requests}, ensure_ascii=False), flush=True)
    rows: list[dict[str, object]] = []
    for path in paths:
        if path.exists():
            with gzip.open(path, "rt", encoding="utf-8") as stream:
                rows.extend(json.loads(line) for line in stream if line.strip())
    if not rows:
        raise ValueError("三連単払戻を保存できませんでした")
    frame = pd.DataFrame(rows).drop_duplicates(["race_id", "first", "second", "third"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(args.output, index=False)
    report = {"start_date": args.start_date, "end_date": args.end_date,
              "races": int(frame["race_id"].nunique()), "payout_rows": int(len(frame)),
              "errors": errors, "created_at": datetime.now(timezone.utc).isoformat()}
    args.output.with_suffix(".audit.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA公式結果から三連単払戻を低負荷で取得します")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("data/raw/jra-trifecta"))
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=4.0)
    parser.add_argument("--permission-confirmed", action="store_true")
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(backfill(args)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
