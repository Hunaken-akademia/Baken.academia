from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from lxml import html

from .jra_backfill import PoliteJraClient, _first, _text


def summarize_tables(payload: bytes) -> list[dict[str, object]]:
    document = html.fromstring(payload.decode("cp932", errors="replace"))
    summaries: list[dict[str, object]] = []
    for table in document.xpath("//table"):
        rows = []
        for row in table.xpath(".//tr"):
            cells = []
            for cell in row.xpath("./th|./td"):
                cells.append(
                    {
                        "tag": cell.tag,
                        "class": cell.get("class", ""),
                        "text": _text(cell)[:160],
                    }
                )
            if cells:
                rows.append(cells)

        owner = _first(table, "ancestor::*[@id][1]")
        summaries.append(
            {
                "owner_id": owner.get("id", "") if owner is not None else "",
                "owner_class": owner.get("class", "") if owner is not None else "",
                "class": table.get("class", ""),
                "summary": table.get("summary", ""),
                "rows": rows,
            }
        )
    return summaries


async def run(args: argparse.Namespace) -> None:
    if not args.permission_confirmed:
        raise ValueError("JRAの許可確認後、--permission-confirmed を付けてください")
    async with PoliteJraClient(args.cache_dir, 3.0, 4.0) as client:
        payload = await client.fetch(args.cname, use_cache=False)
    summary = {
        "source": "JRA公式",
        "source_cname": args.cname,
        "network_requests": client.stats.network_requests,
        "tables": summarize_tables(payload),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="JRA結果ページの表構造を1ページだけ確認します")
    parser.add_argument("--cname", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, default=Path("data/raw/jra/probe-cache"))
    parser.add_argument("--permission-confirmed", action="store_true")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
