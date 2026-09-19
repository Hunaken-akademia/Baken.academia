from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import random
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import aiohttp
import pandas as pd
from lxml import html


BASE_URL = "https://www.jra.go.jp"
ACCESS_S_URL = f"{BASE_URL}/JRADB/accessS.html"
ACCESS_O_URL = f"{BASE_URL}/JRADB/accessO.html"
ENTRY_CNAME = "pw01skl00999999/B3"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 "
    "BakenAcademia-JRA-Backfill/1.0"
)


def _text(node) -> str:
    if node is None:
        return ""
    return " ".join(" ".join(node.xpath(".//text()" )).split())


def _first(node, xpath: str):
    values = node.xpath(xpath)
    return values[0] if values else None


def _int(value: str | None) -> int | None:
    if value is None:
        return None
    matched = re.search(r"-?\d+", value.replace(",", ""))
    return int(matched.group()) if matched else None


def _float(value: str | None) -> float | None:
    if value is None:
        return None
    matched = re.search(r"-?\d+(?:\.\d+)?", value.replace(",", ""))
    return float(matched.group()) if matched else None


def _id_from_value(value: str | None, prefix: str) -> str | None:
    if not value:
        return None
    matched = re.search(re.escape(prefix) + r"(\d+)", value)
    return matched.group(1) if matched else None


def _parse_japanese_date(value: str) -> date:
    matched = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", value)
    if not matched:
        raise ValueError(f"開催日を解析できません: {value}")
    return date(*(int(part) for part in matched.groups()))


def _parse_surface(category: str, course: str) -> str:
    if "障害" in category or "芝→ダート" in course:
        return "障害"
    if "ダート" in course:
        return "ダート"
    if "芝" in course:
        return "芝"
    raise ValueError(f"馬場種別を解析できません: category={category}, course={course}")


def _parse_going(unit, surface: str) -> str | None:
    values: dict[str, str] = {}
    for item in unit.xpath(".//div[contains(@class,'date_line')]//li"):
        cap = _text(_first(item, ".//span[contains(@class,'cap')]"))
        value = _text(_first(item, ".//span[contains(@class,'txt')]"))
        if cap and value:
            values[cap] = value
    if surface == "芝":
        return values.get("芝")
    if surface == "ダート":
        return values.get("ダート")
    obstacle = [(key, values[key]) for key in ("芝", "ダート") if key in values]
    if not obstacle:
        return None
    unique = {value for _, value in obstacle}
    return unique.pop() if len(unique) == 1 else "/".join(f"{k}:{v}" for k, v in obstacle)


def _parse_laps(unit) -> tuple[list[float], float | None, float | None]:
    lap_times: list[float] = []
    last_4f = None
    last_3f = None
    for table in unit.xpath("./table[contains(concat(' ',normalize-space(@class),' '),' narrow ')]"):
        for row in table.xpath(".//tr"):
            heading = _text(_first(row, "./th"))
            value = _text(_first(row, "./td"))
            if "ハロンタイム" in heading:
                lap_times = [float(item) for item in re.findall(r"\d+\.\d+", value)]
            elif "上り" in heading:
                match_4f = re.search(r"4F\s*(\d+\.\d+)", value)
                match_3f = re.search(r"3F\s*(\d+\.\d+)", value)
                last_4f = float(match_4f.group(1)) if match_4f else None
                last_3f = float(match_3f.group(1)) if match_3f else None
    return lap_times, last_4f, last_3f


def parse_results_page(payload: bytes, source_cname: str) -> list[dict[str, object]]:
    document = html.fromstring(payload.decode("cp932", errors="replace"))
    rows: list[dict[str, object]] = []

    for unit in document.xpath("//div[starts-with(@id,'race_result_')]"):
        result_table = _first(
            unit,
            "./table[contains(concat(' ',normalize-space(@class),' '),' striped ')]",
        )
        if result_table is None:
            continue

        race_no = _int(unit.get("id"))
        date_line = _text(_first(unit, ".//div[contains(@class,'date_line')]//div[contains(@class,'date')]"))
        race_date = _parse_japanese_date(date_line)
        course_match = re.search(r"\d+回(.+?)\d+日", date_line)
        if not course_match:
            raise ValueError(f"競馬場を解析できません: {date_line}")
        racecourse = course_match.group(1)

        category = _text(_first(unit, ".//div[contains(@class,'race_title')]//div[contains(@class,'category')]"))
        race_class = _text(_first(unit, ".//div[contains(@class,'race_title')]//div[contains(concat(' ',normalize-space(@class),' '),' class ')]"))
        race_rule = _text(_first(unit, ".//div[contains(@class,'race_title')]//div[contains(@class,'rule')]"))
        weight_rule = _text(_first(unit, ".//div[contains(@class,'race_title')]//div[contains(@class,'weight')]"))
        race_name = _text(_first(unit, ".//span[contains(@class,'race_name')]"))
        course_text = _text(_first(unit, ".//div[contains(@class,'race_title')]//div[contains(@class,'course')]"))
        distance_m = _int(course_text)
        surface = _parse_surface(category, course_text)
        going = _parse_going(unit, surface)
        weather = _text(_first(unit, ".//li[contains(@class,'weather')]//span[contains(@class,'txt')]")) or None
        start_time = _text(_first(unit, ".//div[contains(@class,'date_line')]//div[contains(@class,'time')]//strong")) or None
        lap_times, last_4f, last_3f = _parse_laps(unit)
        race_id = f"{race_date:%Y%m%d}-{racecourse}-{race_no:02d}"

        for runner in result_table.xpath("./tbody/tr"):
            horse_link = _first(runner, "./td[contains(@class,'horse')]//a[contains(@href,'accessU.html')]")
            if horse_link is None:
                continue
            horse_name = _text(horse_link)
            horse_id = _id_from_value(horse_link.get("href"), "pw01dud10")
            if not horse_id:
                raise ValueError(f"馬IDを解析できません: {horse_name}")

            place_raw = _text(_first(runner, "./td[contains(@class,'place')]"))
            age_text = _text(_first(runner, "./td[contains(@class,'age')]"))
            sex_match = re.match(r"(せん|牡|牝)", age_text)
            weight_text = _text(_first(runner, "./td[contains(@class,'h_weight')]"))
            body_match = re.search(r"(\d+)\s*\(([+-]?\d+)\)", weight_text)
            jockey_link = _first(runner, "./td[contains(@class,'jockey')]/a")
            trainer_link = _first(runner, "./td[contains(@class,'trainer')]/a")
            gate_img = _first(runner, "./td[contains(@class,'waku')]//img")
            corners = [
                _text(item)
                for item in runner.xpath("./td[contains(@class,'corner')]//li")
                if _text(item)
            ]

            rows.append(
                {
                    "race_id": race_id,
                    "race_date": race_date.isoformat(),
                    "race_no": race_no,
                    "racecourse": racecourse,
                    "race_name": race_name,
                    "race_class": race_class or category,
                    "race_category": category,
                    "race_rule": race_rule,
                    "weight_rule": weight_rule,
                    "surface": surface,
                    "distance_m": distance_m,
                    "course_detail": course_text,
                    "going": going,
                    "weather": weather,
                    "start_time": start_time,
                    "horse_id": horse_id,
                    "horse_name": horse_name,
                    "finish_position": _int(place_raw) if place_raw.isdigit() else None,
                    "finish_status": place_raw,
                    "gate": _int(gate_img.get("alt") if gate_img is not None else None),
                    "horse_number": _int(_text(_first(runner, "./td[contains(@class,'num')]"))),
                    "sex": sex_match.group(1) if sex_match else None,
                    "age": _int(age_text),
                    "weight_carried": _float(_text(_first(runner, "./td[contains(@class,'weight')]"))),
                    "jockey_id": _id_from_value(jockey_link.get("onclick") if jockey_link is not None else None, "pw04kmk00"),
                    "jockey_name": _text(jockey_link) or None,
                    "finish_time": _text(_first(runner, "./td[contains(@class,'time')]")) or None,
                    "margin": _text(_first(runner, "./td[contains(@class,'margin')]")) or None,
                    "corner_positions": json.dumps(corners, ensure_ascii=False),
                    "avg_1f": _float(_text(_first(runner, "./td[contains(@class,'f_time')]"))),
                    "horse_weight": int(body_match.group(1)) if body_match else _int(weight_text),
                    "horse_weight_change": int(body_match.group(2)) if body_match else None,
                    "trainer_id": _id_from_value(trainer_link.get("onclick") if trainer_link is not None else None, "pw05cmk00"),
                    "trainer_name": _text(trainer_link) or None,
                    "popularity": _int(_text(_first(runner, "./td[contains(@class,'pop')]"))),
                    "lap_times": json.dumps(lap_times, ensure_ascii=False),
                    "race_last_4f": last_4f,
                    "race_last_3f": last_3f,
                    "source": "JRA公式",
                    "source_cname": source_cname,
                }
            )
    return rows


def parse_month_checksums(payload: bytes) -> dict[str, str]:
    decoded = payload.decode("cp932", errors="replace")
    return dict(re.findall(r'objParam\["(\d{4})"\]="([0-9A-F]{2})"', decoded))


def parse_current_year_month(payload: bytes) -> int:
    decoded = payload.decode("cp932", errors="replace")
    matched = re.search(r'var\s+yearMonth\s*=\s*"(\d{6})"', decoded)
    if not matched:
        raise ValueError("JRA検索画面から現在年月を解析できません")
    return int(matched.group(1))


def parse_event_cnames(payload: bytes) -> list[str]:
    decoded = payload.decode("cp932", errors="replace")
    return sorted(set(re.findall(r"'((?:pw01srl10)\d+/[0-9A-F]{2})'", decoded)))


def parse_all_results_cname(payload: bytes) -> str:
    decoded = payload.decode("cp932", errors="replace")
    matches = re.findall(r"'((?:pw01ses10)\d+/[0-9A-F]{2})'", decoded)
    if not matches:
        raise ValueError("開催ページから全レース結果リンクを検出できません")
    return matches[0]


def _months(start: date, end: date) -> Iterable[tuple[int, int]]:
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        yield cursor.year, cursor.month
        cursor = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)


def _cname_date(cname: str) -> date | None:
    matched = re.search(r"(20\d{6})/", cname)
    if not matched:
        return None
    return datetime.strptime(matched.group(1), "%Y%m%d").date()


@dataclass
class FetchStats:
    network_requests: int = 0
    cache_hits: int = 0
    retries: int = 0


class PoliteJraClient:
    def __init__(self, cache_dir: Path, min_delay: float, max_delay: float) -> None:
        if min_delay < 2:
            raise ValueError("JRAへの負荷を抑えるため --min-delay は2秒以上にしてください")
        if max_delay < min_delay:
            raise ValueError("--max-delay は --min-delay 以上にしてください")
        self.cache_dir = cache_dir
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.stats = FetchStats()
        self._last_request_at: float | None = None
        self._session: aiohttp.ClientSession | None = None

    async def __aenter__(self):
        timeout = aiohttp.ClientTimeout(total=90)
        self._session = aiohttp.ClientSession(
            headers={"User-Agent": DEFAULT_USER_AGENT, "Referer": f"{BASE_URL}/"},
            timeout=timeout,
            trust_env=True,
        )
        return self

    async def __aexit__(self, *_):
        if self._session is not None:
            await self._session.close()

    async def _wait(self) -> None:
        if self._last_request_at is None:
            return
        loop = asyncio.get_running_loop()
        target = random.uniform(self.min_delay, self.max_delay)
        remaining = target - (loop.time() - self._last_request_at)
        if remaining > 0:
            await asyncio.sleep(remaining)

    async def fetch(
        self,
        cname: str,
        use_cache: bool = True,
        endpoint: str = ACCESS_S_URL,
    ) -> bytes:
        cache_key = cname if endpoint == ACCESS_S_URL else f"{endpoint}\n{cname}"
        digest = hashlib.sha256(cache_key.encode()).hexdigest()
        cache_path = self.cache_dir / digest[:2] / f"{digest}.html.gz"
        if use_cache and cache_path.exists():
            self.stats.cache_hits += 1
            return gzip.decompress(cache_path.read_bytes())

        assert self._session is not None
        for attempt in range(4):
            await self._wait()
            try:
                async with self._session.post(endpoint, data={"cname": cname}) as response:
                    payload = await response.read()
                    self._last_request_at = asyncio.get_running_loop().time()
                    self.stats.network_requests += 1
                    if response.status == 200 and len(payload) > 5_000:
                        if b"\x83p\x83\x89\x83\x81\x81\x5b\x83^\x83G\x83\x89\x81\x5b" in payload:
                            raise RuntimeError(f"JRAがパラメータエラーを返しました: {cname}")
                        cache_path.parent.mkdir(parents=True, exist_ok=True)
                        cache_path.write_bytes(gzip.compress(payload, compresslevel=6))
                        return payload
                    if response.status in {403, 404}:
                        raise RuntimeError(f"JRA HTTP {response.status}: {cname}")
                    if response.status not in {429, 500, 502, 503, 504}:
                        raise RuntimeError(f"JRA HTTP {response.status}: {cname}")
                    retry_after = response.headers.get("Retry-After")
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                retry_after = None
                if attempt == 3:
                    raise RuntimeError(f"JRA取得失敗: {cname}: {exc}") from exc
            self.stats.retries += 1
            pause = float(retry_after) if retry_after and retry_after.isdigit() else 15 * (2**attempt)
            await asyncio.sleep(min(pause, 120))
        raise RuntimeError(f"JRA取得失敗: {cname}")


def _read_event_rows(path: Path) -> list[dict[str, object]]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def _write_event_rows(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary.replace(path)


async def backfill(args: argparse.Namespace) -> dict[str, object]:
    if not args.permission_confirmed:
        raise ValueError("JRAの許可確認後、--permission-confirmed を付けてください")
    start = date.fromisoformat(args.start_date)
    end = date.fromisoformat(args.end_date)
    if end < start:
        raise ValueError("end-date は start-date 以降にしてください")

    work_dir = args.work_dir
    event_dir = work_dir / "events"
    cache_dir = work_dir / "cache"
    all_event_paths: list[Path] = []
    errors: list[dict[str, str]] = []
    processed = 0

    async with PoliteJraClient(cache_dir, args.min_delay, args.max_delay) as client:
        entry = await client.fetch(ENTRY_CNAME)
        checksums = parse_month_checksums(entry)
        current_year_month = parse_current_year_month(entry)

        event_cnames: list[str] = []
        for year, month in _months(start, end):
            key = f"{year % 100:02d}{month:02d}"
            checksum = checksums.get(key)
            if not checksum:
                raise ValueError(f"JRA検索画面に年月チェック値がありません: {year}-{month:02d}")
            target_year_month = int(f"{year}{month:02d}")
            prefix = "pw01skl00" if target_year_month >= current_year_month else "pw01skl10"
            month_cname = f"{prefix}{year}{month:02d}/{checksum}"
            month_payload = entry if target_year_month == current_year_month else await client.fetch(month_cname)
            event_cnames.extend(parse_event_cnames(month_payload))

        selected = []
        for cname in sorted(set(event_cnames)):
            event_date = _cname_date(cname)
            if event_date and start <= event_date <= end:
                selected.append(cname)
        if args.max_events is not None:
            selected = selected[: args.max_events]

        print(json.dumps({"event_pages": len(selected), "start": str(start), "end": str(end)}, ensure_ascii=False), flush=True)

        for index, event_cname in enumerate(selected, 1):
            event_date = _cname_date(event_cname)
            event_key = event_cname.split("/")[0]
            event_path = event_dir / str(event_date.year) / f"{event_key}.jsonl.gz"
            all_event_paths.append(event_path)
            if event_path.exists():
                continue
            try:
                event_page = await client.fetch(event_cname)
                all_cname = parse_all_results_cname(event_page)
                results_page = await client.fetch(all_cname)
                rows = parse_results_page(results_page, all_cname)
                if not rows:
                    raise ValueError("出走行が0件です")
                winners_by_race: dict[str, int] = {}
                for row in rows:
                    race_id = str(row["race_id"])
                    winners_by_race.setdefault(race_id, 0)
                    winners_by_race[race_id] += int(row["finish_position"] == 1)
                invalid = {key: value for key, value in winners_by_race.items() if value not in {1, 2}}
                if invalid:
                    raise ValueError(f"1着馬数が不正です: {next(iter(invalid.items()))}")
                _write_event_rows(event_path, rows)
                processed += 1
            except Exception as exc:
                errors.append({"event_cname": event_cname, "error": str(exc)})
                if not args.continue_on_error:
                    raise
            if index == 1 or index % 25 == 0 or index == len(selected):
                print(
                    json.dumps(
                        {
                            "progress": f"{index}/{len(selected)}",
                            "completed_now": processed,
                            "network_requests": client.stats.network_requests,
                            "cache_hits": client.stats.cache_hits,
                            "errors": len(errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

        rows: list[dict[str, object]] = []
        for path in sorted(set(all_event_paths)):
            if path.exists():
                rows.extend(_read_event_rows(path))
        if not rows:
            raise ValueError("保存できたJRAデータがありません")
        frame = pd.DataFrame(rows)
        frame["race_date"] = pd.to_datetime(frame["race_date"])
        frame = frame.sort_values(["race_date", "racecourse", "race_no", "horse_number"])
        frame = frame.drop_duplicates(["race_id", "horse_id"], keep="last")
        winner_counts = frame.assign(
            _winner=(frame["finish_position"] == 1).astype(int)
        ).groupby("race_id", observed=True)["_winner"].transform("sum")
        frame["is_dead_heat"] = winner_counts > 1
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if args.output.name.endswith(".parquet"):
            frame.to_parquet(args.output, index=False)
        elif args.output.name.endswith((".csv", ".csv.gz")):
            frame.to_csv(args.output, index=False, encoding="utf-8")
        else:
            raise ValueError("--output は .parquet / .csv / .csv.gz のいずれかにしてください")

        report = {
            "source": "JRA公式",
            "permission_confirmed_by_operator": True,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "rows": int(len(frame)),
            "races": int(frame["race_id"].nunique()),
            "horses": int(frame["horse_id"].nunique()),
            "event_pages_selected": len(selected),
            "event_pages_available": sum(path.exists() for path in set(all_event_paths)),
            "network_requests": client.stats.network_requests,
            "cache_hits": client.stats.cache_hits,
            "retries": client.stats.retries,
            "errors": errors,
            "dead_heat_races": int(frame.loc[frame["is_dead_heat"], "race_id"].nunique()),
            "missing_rate": {
                name: round(float(frame[name].isna().mean()), 6)
                for name in sorted(frame.columns)
            },
            "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        }
        report_path = args.output.with_suffix(".audit.json")
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report


def main() -> None:
    today = date.today()
    parser = argparse.ArgumentParser(description="JRA公式サイトから許諾済みレース結果を低負荷で取得します")
    parser.add_argument("--start-date", default=f"{today.year - 7}-01-01")
    parser.add_argument("--end-date", default=today.isoformat())
    parser.add_argument("--output", type=Path, default=Path("data/raw/jra/races.parquet"))
    parser.add_argument("--work-dir", type=Path, default=Path("data/raw/jra"))
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=4.0)
    parser.add_argument("--max-events", type=int)
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--permission-confirmed", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(backfill(args))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["errors"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
