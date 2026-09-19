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


BET_TYPES = {
    "1": ("win_place", "単勝・複勝"),
    "2": ("bracket_quinella", "枠連"),
    "3": ("quinella", "馬連"),
    "4": ("wide", "ワイド"),
    "5": ("exacta", "馬単"),
    "6": ("trio", "三連複"),
    "7": ("trifecta", "三連単"),
}

ODDS_CNAME_PATTERN = re.compile(
    r"pw15(?P<kind>[1-7])ou10(?P<course>\d{2})(?P<year>\d{4})(?P<meeting>\d{2})"
    r"(?P<day>\d{2})(?P<race>\d{2})(?P<date>20\d{6})Z/[0-9A-F]{2}"
)


def parse_all_odds_cnames(payload: bytes) -> list[str]:
    decoded = payload.decode("cp932", errors="replace")
    return list(dict.fromkeys(match.group(0) for match in ODDS_CNAME_PATTERN.finditer(decoded)))


def merge_odds_cnames(*payloads: bytes) -> list[str]:
    """Discover result-page links plus the remaining bet tabs on the win/place page."""
    return list(dict.fromkeys(
        cname for payload in payloads for cname in parse_all_odds_cnames(payload)
    ))


async def fetch_odds_families(
    client, result_payload: bytes, endpoint: str, race_no: int | None = None
) -> dict[str, bytes]:
    """Follow odds navigation until all reachable bet pages have been fetched once."""
    payloads: dict[str, bytes] = {}
    queue = parse_all_odds_cnames(result_payload)
    while queue:
        cname = queue.pop(0)
        if cname in payloads:
            continue
        payload = await client.fetch(cname, endpoint=endpoint)
        payloads[cname] = payload
        for linked in parse_all_odds_cnames(payload):
            if race_no is not None and parse_odds_cname(linked)["race_no"] != race_no:
                continue
            if linked not in payloads and linked not in queue:
                queue.append(linked)
    return payloads


def parse_odds_cname(cname: str) -> dict[str, object]:
    matched = ODDS_CNAME_PATTERN.fullmatch(cname)
    if not matched:
        raise ValueError(f"券種別オッズCNAMEを解析できません: {cname}")
    values = matched.groupdict()
    bet_type, label = BET_TYPES[values["kind"]]
    return {
        "bet_type": bet_type,
        "bet_type_label": label,
        "course_code": values["course"],
        "race_no": int(values["race"]),
        "race_date": datetime.strptime(values["date"], "%Y%m%d").date(),
    }


def parse_odds_cells(payload: bytes, cname: str) -> list[dict[str, object]]:
    """Store every odds-table cell losslessly so every bet type remains re-parsable."""
    meta = parse_odds_cname(cname)
    document = html.fromstring(payload.decode("cp932", errors="replace"))
    rows: list[dict[str, object]] = []
    for table_index, table in enumerate(document.xpath("//table")):
        table_class = " ".join((table.get("class") or "").split())
        for row_index, tr in enumerate(table.xpath(".//tr")):
            for cell_index, cell in enumerate(tr.xpath("./th|./td")):
                text = " ".join(" ".join(cell.xpath(".//text()")).split())
                if not text and cell.get("class") is None:
                    continue
                rows.append(
                    {
                        **meta,
                        "source_cname": cname,
                        "table_index": table_index,
                        "table_class": table_class,
                        "row_index": row_index,
                        "cell_index": cell_index,
                        "tag": cell.tag,
                        "cell_class": " ".join((cell.get("class") or "").split()),
                        "text": text,
                        "rowspan": int(cell.get("rowspan", "1") or 1),
                        "colspan": int(cell.get("colspan", "1") or 1),
                    }
                )
    if not rows:
        raise ValueError(f"オッズ表がありません: {cname}")
    return rows


def parse_win_place_odds(payload: bytes, cname: str) -> list[dict[str, object]]:
    meta = parse_odds_cname(cname)
    if meta["bet_type"] != "win_place":
        return []
    document = html.fromstring(payload.decode("cp932", errors="replace"))
    records: list[dict[str, object]] = []
    for tr in document.xpath("//table[contains(@class,'tanpuku')]//tr"):
        number_text = " ".join(tr.xpath("string(./td[contains(@class,'num')])").split())
        matched = re.search(r"\d+", number_text)
        if not matched:
            continue
        win_text = " ".join(tr.xpath("string(./td[contains(@class,'odds_tan')])").split())
        place_text = " ".join(tr.xpath("string(./td[contains(@class,'odds_fuku')])").split())
        win = re.search(r"\d+(?:\.\d+)?", win_text.replace(",", ""))
        place = [float(value) for value in re.findall(r"\d+(?:\.\d+)?", place_text.replace(",", ""))]
        records.append(
            {
                **meta,
                "source_cname": cname,
                "horse_number": int(matched.group()),
                "win_odds": float(win.group()) if win else None,
                "place_odds_min": place[0] if place else None,
                "place_odds_max": place[-1] if place else None,
                "win_status": win_text or None,
                "place_status": place_text or None,
            }
        )
    return records


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _write_gzip(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wb") as stream:
        stream.write(payload)
    temporary.replace(path)


async def backfill(args: argparse.Namespace) -> dict[str, object]:
    from .jra_backfill import ACCESS_O_URL, PoliteJraClient
    from .jra_all_payouts import parse_all_payouts

    if not args.permission_confirmed:
        raise ValueError("JRAの許可確認後、--permission-confirmed を付けてください")
    start, end = date.fromisoformat(args.start_date), date.fromisoformat(args.end_date)
    source = pd.read_parquet(args.input)
    source["race_date"] = pd.to_datetime(source["race_date"])
    selected = source.loc[source["race_date"].dt.date.between(start, end)].copy()
    if selected.empty:
        raise ValueError("指定期間のJRAレースがありません")
    pages = selected["source_cname"].dropna().astype(str).drop_duplicates().sort_values().tolist()
    manifests: list[dict[str, object]] = []
    cell_rows: list[dict[str, object]] = []
    win_place_rows: list[dict[str, object]] = []
    payout_rows: list[dict[str, object]] = []
    errors: list[dict[str, str]] = []
    async with PoliteJraClient(args.work_dir / "http-cache", args.min_delay, args.max_delay) as client:
        for index, result_cname in enumerate(pages, 1):
            try:
                result_payload = await client.fetch(result_cname)
                payout_rows.extend(parse_all_payouts(result_payload, result_cname))
                odds_payloads = await fetch_odds_families(client, result_payload, ACCESS_O_URL)
                odds_cnames = list(odds_payloads)
                for cname in odds_cnames:
                    meta = parse_odds_cname(cname)
                    race_date = meta["race_date"]
                    if not start <= race_date <= end:
                        continue
                    raw_path = args.work_dir / "pages" / str(race_date.year) / f"{_digest(cname)}.html.gz"
                    if cname in odds_payloads:
                        payload = odds_payloads[cname]
                        if not raw_path.exists():
                            _write_gzip(raw_path, payload)
                    elif raw_path.exists():
                        with gzip.open(raw_path, "rb") as stream:
                            payload = stream.read()
                    else:
                        payload = await client.fetch(cname, endpoint=ACCESS_O_URL)
                        _write_gzip(raw_path, payload)
                    cells = parse_odds_cells(payload, cname)
                    cell_rows.extend(cells)
                    win_place_rows.extend(parse_win_place_odds(payload, cname))
                    manifests.append(
                        {
                            **meta,
                            "result_cname": result_cname,
                            "odds_cname": cname,
                            "raw_path": str(raw_path),
                            "raw_sha256": hashlib.sha256(payload).hexdigest(),
                            "cells": len(cells),
                        }
                    )
            except Exception as exc:
                errors.append({"result_cname": result_cname, "error": str(exc)})
                if not args.continue_on_error:
                    raise
            if index == 1 or index % 20 == 0 or index == len(pages):
                print(json.dumps({"result_pages": f"{index}/{len(pages)}", "odds_pages": len(manifests),
                                  "requests": client.stats.network_requests, "errors": len(errors)},
                                 ensure_ascii=False), flush=True)
    if not manifests:
        raise ValueError("保存できたJRA券種別オッズがありません")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = pd.DataFrame(manifests).drop_duplicates("odds_cname")
    cells = pd.DataFrame(cell_rows).drop_duplicates(
        ["source_cname", "table_index", "row_index", "cell_index"]
    )
    manifest.to_parquet(args.output_dir / "pages.parquet", index=False)
    cells.to_parquet(args.output_dir / "cells.parquet", index=False)
    if win_place_rows:
        pd.DataFrame(win_place_rows).drop_duplicates(
            ["source_cname", "horse_number"]
        ).to_parquet(args.output_dir / "win-place.parquet", index=False)
    if payout_rows:
        pd.DataFrame(payout_rows).drop_duplicates(
            ["race_id", "bet_type", "selection_1", "selection_2", "selection_3"]
        ).to_parquet(args.output_dir / "payouts.parquet", index=False)
    counts = manifest.groupby("bet_type").size().to_dict()
    report = {
        "source": "JRA公式・全通常馬券最終オッズ",
        "bet_types": list(BET_TYPES.values()),
        "start_date": args.start_date,
        "end_date": args.end_date,
        "result_pages": len(pages),
        "odds_pages": len(manifest),
        "pages_by_bet_type": {str(key): int(value) for key, value in counts.items()},
        "cell_rows": len(cells),
        "payout_rows": len(payout_rows),
        "errors": errors,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (args.output_dir / "audit.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA公式の全通常馬券最終オッズを低負荷・再開可能に取得します")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("data/raw/jra-all-odds"))
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=4.0)
    parser.add_argument("--permission-confirmed", action="store_true")
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(backfill(args)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
