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

from .jra_backfill import ACCESS_O_URL, PoliteJraClient, _first, _float, _int, _text


ODDS_CNAME_PATTERN = re.compile(
    r"pw151ou10(?P<course>\d{2})(?P<year>\d{4})(?P<meeting>\d{2})"
    r"(?P<day>\d{2})(?P<race>\d{2})(?P<date>20\d{6})Z/[0-9A-F]{2}"
)


def parse_odds_cnames(payload: bytes) -> list[str]:
    decoded = payload.decode("cp932", errors="replace")
    return list(dict.fromkeys(match.group(0) for match in ODDS_CNAME_PATTERN.finditer(decoded)))


def parse_odds_cname(cname: str) -> dict[str, object]:
    match = ODDS_CNAME_PATTERN.fullmatch(cname)
    if not match:
        raise ValueError(f"単複オッズCNAMEを解析できません: {cname}")
    values = match.groupdict()
    return {
        "course_code": values["course"],
        "race_no": int(values["race"]),
        "race_date": datetime.strptime(values["date"], "%Y%m%d").date(),
    }


def parse_win_odds_page(payload: bytes) -> list[dict[str, object]]:
    document = html.fromstring(payload.decode("cp932", errors="replace"))
    table = _first(
        document,
        "//table[contains(concat(' ',normalize-space(@class),' '),' tanpuku ')]",
    )
    if table is None:
        raise ValueError("JRA単複オッズ表がありません")
    rows: list[dict[str, object]] = []
    for runner in table.xpath("./tbody/tr|./tr"):
        horse_number = _int(_text(_first(runner, "./td[contains(@class,'num')]")))
        if horse_number is None:
            continue
        odds_text = _text(_first(runner, "./td[contains(@class,'odds_tan')]"))
        rows.append(
            {
                "horse_number": horse_number,
                "horse_name": _text(_first(runner, "./td[contains(@class,'horse')]")) or None,
                "win_odds": _float(odds_text),
                "odds_status": odds_text or None,
            }
        )
    if not rows:
        raise ValueError("JRA単複オッズ表の出走行が0件です")
    return rows


def _checkpoint_path(work_dir: Path, race_date: date, cname: str) -> Path:
    digest = hashlib.sha256(cname.encode()).hexdigest()
    return work_dir / "races" / str(race_date.year) / f"{digest}.jsonl.gz"


def _write_rows(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary.replace(path)


def _read_rows(path: Path) -> list[dict[str, object]]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


async def backfill(args: argparse.Namespace) -> dict[str, object]:
    if not args.permission_confirmed:
        raise ValueError("JRAの許可確認後、--permission-confirmed を付けてください")
    start = date.fromisoformat(args.start_date)
    end = date.fromisoformat(args.end_date)
    if end < start:
        raise ValueError("end-date は start-date 以降にしてください")

    source = pd.read_parquet(args.input)
    required = {"race_id", "race_date", "race_no", "horse_id", "horse_number", "source_cname"}
    missing = sorted(required - set(source.columns))
    if missing:
        raise ValueError(f"入力JRAデータに列が不足しています: {', '.join(missing)}")
    source["race_date"] = pd.to_datetime(source["race_date"])
    selected = source.loc[source["race_date"].dt.date.between(start, end)].copy()
    if selected.empty:
        raise ValueError("指定期間のJRAレースがありません")

    result_pages = selected["source_cname"].dropna().drop_duplicates().sort_values().tolist()
    errors: list[dict[str, str]] = []
    checkpoints: list[Path] = []
    completed_now = 0

    async with PoliteJraClient(args.work_dir / "cache", args.min_delay, args.max_delay) as client:
        for page_index, source_cname in enumerate(result_pages, 1):
            page_rows = selected.loc[selected["source_cname"] == source_cname]
            lookup = {
                (int(row.race_no), int(row.horse_number)): (str(row.race_id), str(row.horse_id))
                for row in page_rows.itertuples()
                if pd.notna(row.race_no) and pd.notna(row.horse_number)
            }
            try:
                results_payload = await client.fetch(str(source_cname))
                odds_cnames = parse_odds_cnames(results_payload)
                if not odds_cnames:
                    raise ValueError("結果ページに単複オッズリンクがありません")
                for odds_cname in odds_cnames:
                    meta = parse_odds_cname(odds_cname)
                    race_date = meta["race_date"]
                    race_no = int(meta["race_no"])
                    if not start <= race_date <= end or not any(key[0] == race_no for key in lookup):
                        continue
                    checkpoint = _checkpoint_path(args.work_dir, race_date, odds_cname)
                    checkpoints.append(checkpoint)
                    if checkpoint.exists():
                        continue
                    odds_payload = await client.fetch(odds_cname, endpoint=ACCESS_O_URL)
                    odds_rows = parse_win_odds_page(odds_payload)
                    enriched: list[dict[str, object]] = []
                    for odds_row in odds_rows:
                        identity = lookup.get((race_no, int(odds_row["horse_number"])))
                        if identity is None:
                            continue
                        race_id, horse_id = identity
                        enriched.append(
                            {
                                "race_id": race_id,
                                "race_date": race_date.isoformat(),
                                "race_no": race_no,
                                "horse_id": horse_id,
                                **odds_row,
                                "source": "JRA公式・最終単複オッズ",
                                "source_cname": str(source_cname),
                                "odds_cname": odds_cname,
                            }
                        )
                    if not enriched:
                        raise ValueError(f"単勝オッズを既存レースに結合できません: {odds_cname}")
                    _write_rows(checkpoint, enriched)
                    completed_now += 1
            except Exception as exc:
                errors.append({"source_cname": str(source_cname), "error": str(exc)})
                if not args.continue_on_error:
                    raise
            if page_index == 1 or page_index % 20 == 0 or page_index == len(result_pages):
                print(
                    json.dumps(
                        {
                            "result_pages": f"{page_index}/{len(result_pages)}",
                            "odds_races_completed_now": completed_now,
                            "network_requests": client.stats.network_requests,
                            "cache_hits": client.stats.cache_hits,
                            "errors": len(errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

        rows: list[dict[str, object]] = []
        for path in sorted(set(checkpoints)):
            if path.exists():
                rows.extend(_read_rows(path))
        if not rows:
            raise ValueError("保存できたJRA単勝オッズがありません")
        frame = pd.DataFrame(rows).drop_duplicates(["race_id", "horse_id"], keep="last")
        frame["race_date"] = pd.to_datetime(frame["race_date"])
        frame = frame.sort_values(["race_date", "race_id", "horse_number"])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(args.output, index=False)

        expected = selected[["race_id", "horse_id"]].drop_duplicates()
        captured = frame.loc[frame["win_odds"].notna(), ["race_id", "horse_id"]].drop_duplicates()
        report = {
            "source": "JRA公式・最終単複オッズ",
            "permission_confirmed_by_operator": True,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "rows": int(len(frame)),
            "races": int(frame["race_id"].nunique()),
            "rows_with_win_odds": int(frame["win_odds"].notna().sum()),
            "expected_races": int(selected["race_id"].nunique()),
            "runner_coverage": round(len(captured) / len(expected), 6),
            "result_pages": len(result_pages),
            "network_requests": client.stats.network_requests,
            "cache_hits": client.stats.cache_hits,
            "retries": client.stats.retries,
            "errors": errors,
            "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        }
        args.output.with_suffix(".audit.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA公式の最終単勝オッズを低負荷・再開可能に取得します")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("data/raw/jra-odds"))
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=4.0)
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--permission-confirmed", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(backfill(args))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["errors"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
