from __future__ import annotations

import re
from datetime import date

from lxml import html


LABELS = {
    "単勝": ("win", 1),
    "複勝": ("place", 1),
    "枠連": ("bracket_quinella", 2),
    "馬連": ("quinella", 2),
    "ワイド": ("wide", 2),
    "馬単": ("exacta", 2),
    "3連複": ("trio", 3),
    "三連複": ("trio", 3),
    "3連単": ("trifecta", 3),
    "三連単": ("trifecta", 3),
}


def _text(node) -> str:
    return " ".join(" ".join(node.xpath(".//text()")).split()) if node is not None else ""


def _first(node, xpath: str):
    values = node.xpath(xpath)
    return values[0] if values else None


def _extract_selections(text: str, arity: int) -> list[tuple[int, ...]]:
    clean = text.replace("－", "-").replace("→", "-")
    if arity == 1:
        return [(int(value),) for value in re.findall(r"(?<!\d)(\d{1,2})(?!\d)", clean)]
    pattern = r"(\d{1,2})\s*-\s*(\d{1,2})"
    if arity == 3:
        pattern += r"\s*-\s*(\d{1,2})"
    return [tuple(map(int, values)) for values in re.findall(pattern, clean)]


def parse_all_payouts(payload: bytes, source_cname: str) -> list[dict[str, object]]:
    document = html.fromstring(payload.decode("cp932", errors="replace"))
    records: list[dict[str, object]] = []
    for unit in document.xpath("//div[starts-with(@id,'race_result_')]"):
        race_match = re.search(r"\d+", unit.get("id", ""))
        date_line = _text(_first(unit, ".//div[contains(@class,'date_line')]//div[contains(@class,'date')]"))
        date_match = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", date_line)
        course_match = re.search(r"\d+回(.+?)\d+日", date_line)
        if not race_match or not date_match or not course_match:
            continue
        race_no = int(race_match.group())
        race_date = date(*(int(value) for value in date_match.groups()))
        race_id = f"{race_date:%Y%m%d}-{course_match.group(1)}-{race_no:02d}"
        # Current JRA result pages render refunds as li > dl > dd > div.line.
        # Keep the table fallback because older archived pages used table rows.
        groups: list[tuple[str, list[tuple[str, str]]]] = []
        for item in unit.xpath(
            ".//div[contains(concat(' ',normalize-space(@class),' '),' refund_area ')]"
            "//li[.//dt]"
        ):
            label_text = _text(_first(item, ".//dt"))
            label = next((candidate for candidate in LABELS if candidate in label_text), None)
            if not label:
                continue
            lines = [
                (
                    _text(_first(line, ".//*[contains(concat(' ',normalize-space(@class),' '),' num ')]")),
                    _text(_first(line, ".//*[contains(concat(' ',normalize-space(@class),' '),' yen ')]")),
                )
                for line in item.xpath(
                    ".//*[contains(concat(' ',normalize-space(@class),' '),' line ')]"
                )
            ]
            groups.append((label, lines))

        active_label: str | None = None
        for tr in unit.xpath(".//tr") if not groups else []:
            cells = tr.xpath("./th|./td")
            if not cells:
                continue
            cell_texts = [_text(cell) for cell in cells]
            label = next((candidate for candidate in LABELS if candidate in cell_texts[0]), None)
            if label:
                active_label = label
                value_cells = cell_texts[1:]
            elif active_label:
                value_cells = cell_texts
            else:
                continue
            selection_cells = [value for value in value_cells if "円" not in value]
            payout_cells = [value for value in value_cells if "円" in value]
            groups.append((active_label, list(zip(selection_cells, payout_cells, strict=False))))

        for label, lines in groups:
            bet_type, arity = LABELS[label]
            for selection_text, payout_text in lines:
                selections = [
                    selection for selection in _extract_selections(selection_text, arity)
                    if all(1 <= value <= 18 for value in selection)
                ]
                payout_match = re.search(r"([\d,]+)\s*円", payout_text)
                if not selections or not payout_match:
                    continue
                payout = int(payout_match.group(1).replace(",", ""))
                for selection in selections:
                    records.append(
                        {
                            "race_id": race_id,
                            "race_date": race_date.isoformat(),
                            "race_no": race_no,
                            "bet_type": bet_type,
                            "bet_type_label": label,
                            "selection_1": selection[0],
                            "selection_2": selection[1] if arity >= 2 else None,
                            "selection_3": selection[2] if arity >= 3 else None,
                            "payout_yen_per_100": payout,
                            "source": "JRA公式・払戻",
                            "source_cname": source_cname,
                        }
                    )
    return records
