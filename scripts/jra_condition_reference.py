from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

import pandas as pd
from lxml import html


GRADE_RE = re.compile(r"(?<![A-Z0-9])G\s*([123]|I{1,3})(?![A-Z0-9])", re.I)


def normalized_text(value: object) -> str:
    return unicodedata.normalize("NFKC", "" if pd.isna(value) else str(value)).strip()


def grade_from_row(row: pd.Series) -> str | None:
    text = " ".join(normalized_text(row.get(column)) for column in ("race_class", "race_category", "race_name"))
    compact = text.replace("Grade", "G").replace("グレード", "G")
    matched = GRADE_RE.search(compact)
    if not matched:
        return None
    token = matched.group(1).upper()
    number = token if token in "123" else str(len(token))
    return f"G{number}" if number else None


def race_name_key(value: object) -> str:
    text = normalized_text(value)
    text = re.sub(r"第\s*\d+\s*回", "", text)
    text = re.sub(r"[（(]\s*(?:G|JPN)\s*[123IⅡⅢ]+\s*[)）]", "", text, flags=re.I)
    text = re.sub(r"[（(][^()（）]*[)）]", "", text)
    for full, short in (
        ("アメリカジョッキークラブカップ", "AJCC"),
        ("ニュージーランドトロフィー", "NZT"),
        ("京王杯スプリングカップ", "京王杯SC"),
        ("フューチュリティステークス", "FS"),
        ("ジュベナイルフィリーズ", "JF"),
        ("フィリーズレビュー", "FR"),
        ("ステークス", "S"),
        ("カップ", "C"),
    ):
        text = text.replace(full, short)
    text = re.sub(r"\s+", "", text)
    return text


def distance_band(distance: object) -> str:
    value = int(distance)
    if value < 1400:
        return "short"
    if value <= 1800:
        return "mile"
    if value <= 2400:
        return "middle"
    return "long"


def runner_first_corner(value: object) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        positions = json.loads(value)
    except json.JSONDecodeError:
        return None
    for position in positions if isinstance(positions, list) else []:
        matched = re.search(r"\d+", str(position))
        if matched:
            return int(matched.group())
    return None


def rate(samples: pd.DataFrame, mask: pd.Series) -> dict[str, int | float | None]:
    count = int(len(samples))
    hits = int(mask.loc[samples.index].sum()) if count else 0
    return {"samples": count, "hits": hits, "rate": round(hits / count, 6) if count else None}


def period_stats(races: pd.DataFrame, year: int) -> dict[str, object]:
    period = races.loc[races["race_year"].eq(year)]
    return {
        "races": int(len(period)),
        "winners": int(period["winner_count"].sum()),
        "favoriteWinner": rate(period, period["winner_min_popularity"].eq(1)),
        "top3PopularityWinner": rate(period, period["winner_min_popularity"].le(3)),
        "tenPlusWinner": rate(period, period["winner_max_popularity"].ge(10)),
        "frontWinner": rate(period.loc[period["winner_first_corner"].notna()], period["winner_first_corner"].le(3)),
    }


def official_grade_schedule(directory: Path) -> dict[str, tuple[str, str]]:
    result: dict[str, tuple[str, str]] = {}
    for source in sorted(directory.glob("*.html")):
        year_match = re.search(r"20\d{2}", source.stem)
        if not year_match:
            continue
        year = int(year_match.group())
        payload = source.read_bytes()
        decoded = payload.decode("utf-8", errors="replace")
        if decoded.count("�") > 20:
            decoded = payload.decode("cp932", errors="replace")
        document = html.fromstring(decoded)
        for row in document.xpath("//tr"):
            cells = [" ".join(" ".join(cell.xpath(".//text() | .//@alt")).split()) for cell in row.xpath("./th|./td")]
            if len(cells) < 5:
                continue
            date_match = re.search(r"(\d{1,2})月(\d{1,2})日", cells[0])
            grade_match = re.search(r"(?:J[・･]?\s*)?G\s*([ⅠⅡⅢI]{1,3}|[123])\s*(.+)", normalized_text(cells[1]), re.I)
            distance_match = re.search(r"(\d[\d,]*)", cells[4])
            venue = next((name for name in ("札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉") if name in cells[2]), None)
            surface = "芝" if cells[4].startswith("芝") else "ダート" if cells[4].startswith("ダ") else "障害" if cells[4].startswith("障") else None
            if not date_match or not grade_match or not distance_match or not venue or not surface:
                continue
            token = normalized_text(grade_match.group(1)).upper()
            number = token if token in "123" else str(len(token))
            date = f"{year:04d}-{int(date_match.group(1)):02d}-{int(date_match.group(2)):02d}"
            official_name = normalized_text(grade_match.group(2))
            key = f"{date}|{venue}|{surface}|{int(distance_match.group(1).replace(',', ''))}|{race_name_key(official_name)}"
            result[key] = (f"G{number}", official_name)
    return result


def summarize_races(raw: pd.DataFrame, grade_schedule: dict[str, tuple[str, str]] | None = None) -> pd.DataFrame:
    data = raw.loc[raw["finish_position"].notna() & raw["surface"].isin(["芝", "ダート"])].copy()
    data["race_date"] = pd.to_datetime(data["race_date"])
    data["race_year"] = data["race_date"].dt.year
    data["finish_position"] = pd.to_numeric(data["finish_position"], errors="coerce")
    data["popularity"] = pd.to_numeric(data["popularity"], errors="coerce")
    data["gate"] = pd.to_numeric(data["gate"], errors="coerce")
    data["first_corner"] = data.get("corner_positions", pd.Series(index=data.index, dtype="object")).map(runner_first_corner)
    rows: list[dict[str, object]] = []
    for race_id, group in data.groupby("race_id", sort=False, observed=True):
        winners = group.loc[group["finish_position"].eq(1)]
        placed = group.loc[group["finish_position"].between(1, 3)]
        first = group.iloc[0]
        schedule_key = (
            f"{first['race_date'].date()}|{normalized_text(first['racecourse'])}|"
            f"{normalized_text(first['surface'])}|{int(first['distance_m'])}|{race_name_key(first.get('race_name'))}"
        )
        official = (grade_schedule or {}).get(schedule_key)
        rows.append({
            "race_id": str(race_id), "race_date": first["race_date"], "race_year": int(first["race_year"]),
            "racecourse": normalized_text(first["racecourse"]), "race_name": normalized_text(first.get("race_name")),
            "race_name_key": race_name_key(first.get("race_name")), "grade": grade_from_row(first) or (official[0] if official else None),
            "surface": normalized_text(first["surface"]), "distance_m": int(first["distance_m"]),
            "distance_band": distance_band(first["distance_m"]), "going": normalized_text(first.get("going")) or "不明",
            "field_size": int(len(group)), "winner_count": int(len(winners)),
            "winner_min_popularity": float(winners["popularity"].min()) if winners["popularity"].notna().any() else None,
            "winner_max_popularity": float(winners["popularity"].max()) if winners["popularity"].notna().any() else None,
            "winner_first_corner": float(winners["first_corner"].min()) if winners["first_corner"].notna().any() else None,
            "winner_gate": float(winners["gate"].mean()) if winners["gate"].notna().any() else None,
            "placed_popularities": [int(value) for value in placed["popularity"].dropna().sort_values()],
            "placed_first_corners": [int(value) for value in placed["first_corner"].dropna().sort_values()],
        })
    return pd.DataFrame(rows)


def condition_rows(races: pd.DataFrame, minimum_races: int) -> list[dict[str, object]]:
    conditions = {
        "course": races["racecourse"] + "|" + races["surface"],
        "courseDistance": races["racecourse"] + "|" + races["surface"] + "|" + races["distance_band"],
        "courseGoing": races["racecourse"] + "|" + races["surface"] + "|" + races["going"],
    }
    result = []
    for kind, keys in conditions.items():
        for key, group in races.groupby(keys, sort=True):
            selection, audit = period_stats(group, 2025), period_stats(group, 2026)
            if selection["races"] < minimum_races or audit["races"] < minimum_races:
                continue
            result.append({"kind": kind, "key": key, "selection": selection, "audit": audit})
    return result


def graded_history(races: pd.DataFrame, minimum_editions: int) -> list[dict[str, object]]:
    graded = races.loc[races["grade"].isin(["G1", "G2", "G3"]) & races["race_name_key"].ne("")].copy()
    result = []
    for key, group in graded.groupby("race_name_key", sort=True):
        years = sorted(group["race_year"].unique())
        # Annual races need distinct editions across at least five years. A duplicated
        # same-year title or a one-off graded event must not become a trend card.
        if (
            len(years) < minimum_editions
            or len(group) != len(years)
            or max(years) < 2025
        ):
            continue
        editions = []
        for row in group.sort_values("race_date").itertuples():
            editions.append({
                "date": row.race_date.date().isoformat(), "year": int(row.race_year), "venue": row.racecourse,
                "grade": row.grade, "surface": row.surface, "distanceM": int(row.distance_m), "going": row.going,
                "fieldSize": int(row.field_size), "winnerPopularity": int(row.winner_min_popularity) if pd.notna(row.winner_min_popularity) else None,
                "winnerGate": round(float(row.winner_gate), 2) if pd.notna(row.winner_gate) else None,
                "winnerFirstCorner": int(row.winner_first_corner) if pd.notna(row.winner_first_corner) else None,
                "placedPopularities": row.placed_popularities, "placedFirstCorners": row.placed_first_corners,
            })
        result.append({"key": key, "name": group.iloc[-1]["race_name"], "grades": sorted(group["grade"].unique()), "editions": editions})
    return result


def build(raw: pd.DataFrame, minimum_races: int = 100, minimum_editions: int = 5, grade_schedule: dict[str, tuple[str, str]] | None = None) -> dict[str, object]:
    races = summarize_races(raw, grade_schedule)
    return {
        "version": "jra-condition-reference-v1",
        "periods": {"selection": "2025", "audit": f"2026-01-01–{races['race_date'].max().date()}"},
        "coverage": {"dateFrom": str(races["race_date"].min().date()), "dateTo": str(races["race_date"].max().date()),
                     "races": int(len(races)), "racecourses": int(races["racecourse"].nunique())},
        "minimumRacesPerYear": minimum_races, "conditions": condition_rows(races, minimum_races),
        "gradedRaces": graded_history(races, minimum_editions),
        "limitations": [
            "人気は確定人気による事後集計。発走前人気との差と回収率は未検証。",
            "条件別の数字は勝ち馬に占める割合で、個別レースの的中確率ではない。",
            "重賞傾向は現在年より前の同名開催だけを画面側で使用し、当年結果を混ぜない。",
            "コーナー位置は公式結果に順位がある開催だけを母数とする。",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minimum-races", type=int, default=100)
    parser.add_argument("--minimum-editions", type=int, default=5)
    parser.add_argument("--grade-dir", type=Path)
    args = parser.parse_args()
    grades = official_grade_schedule(args.grade_dir) if args.grade_dir else None
    payload = build(pd.read_parquet(args.input), args.minimum_races, args.minimum_editions, grades)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"coverage": payload["coverage"], "conditions": len(payload["conditions"]),
                      "gradedRaces": len(payload["gradedRaces"]), "officialGradeRows": len(grades or {}), "bytes": args.output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
