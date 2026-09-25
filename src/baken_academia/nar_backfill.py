from __future__ import annotations

import argparse, asyncio, gzip, hashlib, json, random, re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlparse

import aiohttp
import pandas as pd
from lxml import html

BASE_URL = "https://www.keiba.go.jp"
MONTH_URL = f"{BASE_URL}/KeibaWeb/MonthlyConveneInfo/MonthlyConveneInfoTop"
USER_AGENT = "BakenAcademia-NAR-Backfill/1.1 (licensed; sequential low-rate requests)"

ODDS_ENDPOINTS = {
    "win_place": "OddsTanFuku",
    "bracket_quinella": "OddsWakuLenFukuTan",
    "quinella": "OddsUmLenFuku",
    "exacta": "OddsUmLenTan",
    "wide": "OddsWide",
    "trio": "Odds3LenFuku",
    "trifecta": "Odds3LenTan",
}


def _text(node) -> str:
    return "" if node is None else " ".join(" ".join(node.xpath(".//text()")).split())


def _first(node, xpath):
    values = node.xpath(xpath)
    return values[0] if values else None


def _has_class(class_name: str) -> str:
    """Return an XPath predicate that matches one complete HTML class token."""
    return (
        "contains(concat(' ', normalize-space(@class), ' '), "
        f"' {class_name} ')"
    )


def _cell(row, class_name: str):
    return _first(row, f"./td[{_has_class(class_name)}]")


def _int(value):
    matched = re.search(r"-?\d+", (value or "").replace(",", ""))
    return int(matched.group()) if matched else None


def _float(value):
    matched = re.search(r"-?\d+(?:\.\d+)?", (value or "").replace(",", ""))
    return float(matched.group()) if matched else None


def _query(url, name):
    values = parse_qs(urlparse(url or "").query).get(name)
    return values[0] if values else None


def parse_schedule_links(payload: bytes) -> list[str]:
    doc = html.fromstring(payload.decode("utf-8-sig", errors="replace"))
    return sorted(set(
        urljoin(BASE_URL, a.get("href"))
        for a in doc.xpath("//a[contains(@href,'/TodayRaceInfo/RaceList')]")
        if a.get("href") and "k_raceDate=" in a.get("href") and "k_babaCode=" in a.get("href")
    ))


def parse_result_links(payload: bytes) -> list[str]:
    doc = html.fromstring(payload.decode("utf-8-sig", errors="replace"))
    links = set(
        urljoin(BASE_URL, a.get("href"))
        for a in doc.xpath("//a[contains(@href,'/TodayRaceInfo/RaceMarkTable')]")
        if a.get("href") and all(k in a.get("href") for k in ("k_raceDate=", "k_raceNo=", "k_babaCode="))
    )
    return sorted(links, key=lambda u: _int(_query(u, "k_raceNo")) or 0)


def build_odds_urls(result_url: str) -> dict[str, str]:
    params = {
        "k_babaCode": _query(result_url, "k_babaCode"),
        "k_raceDate": _query(result_url, "k_raceDate"),
        "k_raceNo": _query(result_url, "k_raceNo"),
    }
    if not all(params.values()):
        raise ValueError(f"NARオッズURLの元情報が不足しています: {result_url}")
    return {
        bet_type: f"{BASE_URL}/KeibaWeb/TodayRaceInfo/{endpoint}?{urlencode(params)}"
        for bet_type, endpoint in ODDS_ENDPOINTS.items()
    }


def parse_odds_cells(payload: bytes, race_id: str, bet_type: str, source_url: str) -> list[dict[str, object]]:
    """Preserve every table cell from the official final-odds page for lossless re-parsing."""
    doc = html.fromstring(payload.decode("utf-8-sig", errors="replace"))
    rows: list[dict[str, object]] = []
    for table_index, table in enumerate(doc.xpath("//main//table | //section//table")):
        table_class = " ".join((table.get("class") or "").split())
        for row_index, tr in enumerate(table.xpath(".//tr")):
            row_class = " ".join((tr.get("class") or "").split())
            for cell_index, cell in enumerate(tr.xpath("./th|./td")):
                text_value = " ".join(" ".join(cell.xpath(".//text()")).split())
                if not text_value:
                    continue
                rows.append({
                    "race_id": race_id,
                    "bet_type": bet_type,
                    "table_index": table_index,
                    "table_class": table_class,
                    "row_index": row_index,
                    "row_class": row_class,
                    "cell_index": cell_index,
                    "cell_tag": cell.tag,
                    "cell_class": " ".join((cell.get("class") or "").split()),
                    "text": text_value,
                    "source_url": source_url,
                })
    return rows


def _payouts(doc):
    result, current = [], ""
    for table in doc.xpath(f"//section[{_has_class('newRefundTable')}]//table"):
        for row in table.xpath(".//tr"):
            current = _text(_cell(row, "title")) or current
            combination = _text(_first(
                row,
                f"./td[{_has_class('a')} or {_has_class('d')}]",
            ))
            money = _int(_text(_cell(row, "refundMoney")))
            if current and combination and money is not None:
                result.append({"bet_type": current, "combination": combination, "payout_yen": money,
                               "popularity": _int(_text(_cell(row, "c")))})
    return result


def parse_result_page(payload: bytes, source_url: str) -> list[dict[str, object]]:
    doc = html.fromstring(payload.decode("utf-8-sig", errors="replace"))
    heading = _text(_first(doc, "//main//h4[contains(.,'競走成績')]"))
    match = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日.*?([^\s]+?)\s*第\s*(\d+)競走", heading)
    if not match:
        raise ValueError(f"NAR競走見出しを解析できません: {heading}")
    year, month, day, racecourse, race_no = match.groups()
    race_date = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    race_no = int(race_no)
    baba_code = _query(source_url, "k_babaCode")
    race_id = f"{race_date.replace('-', '')}-NAR-{baba_code}-{race_no:02d}"
    title = _first(doc, f"//section[{_has_class('raceTitle')}]")
    conditions = _text(_first(title, f".//ul[{_has_class('dataArea')}]/li[1]"))
    distance_match = re.search(r"(\d+)\s*ｍ", conditions)
    direction_match = re.search(r"ｍ（([^）]+)）", conditions)
    weather_match = re.search(r"天候[：:]\s*([^\s]+)", conditions)
    going_match = re.search(r"馬場[：:]\s*([^\s]+)", conditions)
    payout_json = json.dumps(_payouts(doc), ensure_ascii=False)
    rows = []
    table = _first(doc, f"//section[{_has_class('gradeTable')}]/table")
    if table is None:
        return rows
    for runner in table.xpath(".//tr[td]"):
        horse = _first(runner, f"./td[{_has_class('horseName')}]//a")
        if horse is None:
            continue
        jockey = _first(runner, f"./td[{_has_class('jockeyName')}]//a")
        trainer = _first(runner, f".//a[{_has_class('trainerName')}]")
        sex_age = re.search(r"(せん|牡|牝)\s*(\d+)", _text(_cell(runner, "f")))
        weight_text = _text(_cell(runner, "horseWeight"))
        weight = re.search(r"(\d+)\s*\(([+-]?\d+)\)", weight_text)
        finish = _text(_cell(runner, "a"))
        rows.append({
            "race_id": race_id, "race_date": race_date, "race_no": race_no,
            "racecourse": racecourse.replace(" ", ""), "baba_code": baba_code,
            "race_name": _text(_first(title, ".//h3")),
            "surface": "ダート" if "ダート" in conditions else ("芝" if "芝" in conditions else None),
            "distance_m": int(distance_match.group(1)) if distance_match else None,
            "direction": direction_match.group(1) if direction_match else None,
            "weather": weather_match.group(1) if weather_match else None,
            "going": going_match.group(1) if going_match else None,
            "race_conditions": conditions,
            "finish_position": _int(finish) if finish.isdigit() else None, "finish_status": finish,
            "gate": _int(_text(_cell(runner, "b"))),
            "horse_number": _int(_text(_cell(runner, "c"))),
            "horse_id": _query(horse.get("href"), "k_lineageLoginCode"), "horse_name": _text(horse),
            "affiliation": _text(_cell(runner, "e")) or None,
            "sex": sex_age.group(1) if sex_age else None, "age": int(sex_age.group(2)) if sex_age else None,
            "weight_carried": _float(_text(_cell(runner, "g"))),
            "jockey_id": _query(jockey.get("href") if jockey is not None else None, "k_riderLicenseNo"),
            "jockey_name": _text(jockey).split("（")[0].strip() if jockey is not None else None,
            "trainer_id": _query(trainer.get("href") if trainer is not None else None, "k_trainerLicenseNo"),
            "trainer_name": _text(trainer) or None,
            "horse_weight": int(weight.group(1)) if weight else _int(weight_text),
            "horse_weight_change": int(weight.group(2)) if weight else None,
            "finish_time": _text(_cell(runner, "k")) or None,
            "margin": _text(_cell(runner, "l")) or None,
            "last_3f": _float(_text(_cell(runner, "m"))),
            "popularity": _int(_text(_cell(runner, "o"))),
            "win_odds": _float(_text(_cell(runner, "p"))),
            "payouts": payout_json, "source": "NAR地方競馬情報サイト", "source_url": source_url,
        })
    return rows


@dataclass
class Stats:
    network_requests: int = 0
    cache_hits: int = 0
    retries: int = 0


class PoliteNarClient:
    def __init__(self, cache_dir: Path, min_delay: float, max_delay: float):
        if min_delay < 3:
            raise ValueError("NARへの負荷を抑えるため --min-delay は3秒以上にしてください")
        if max_delay < min_delay:
            raise ValueError("--max-delay は --min-delay 以上にしてください")
        self.cache_dir, self.min_delay, self.max_delay = cache_dir, min_delay, max_delay
        self.stats, self.last, self.session = Stats(), None, None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(headers={"User-Agent": USER_AGENT, "Referer": BASE_URL + "/"},
                                             timeout=aiohttp.ClientTimeout(total=90), trust_env=True)
        return self

    async def __aexit__(self, *_):
        await self.session.close()

    async def fetch(self, url: str) -> bytes:
        digest = hashlib.sha256(url.encode()).hexdigest()
        path = self.cache_dir / digest[:2] / f"{digest}.html.gz"
        if path.exists():
            self.stats.cache_hits += 1
            return gzip.decompress(path.read_bytes())
        for attempt in range(4):
            if self.last is not None:
                wait = random.uniform(self.min_delay, self.max_delay) - (asyncio.get_running_loop().time() - self.last)
                if wait > 0:
                    await asyncio.sleep(wait)
            try:
                async with self.session.get(url) as response:
                    payload = await response.read()
                    self.last, self.stats.network_requests = asyncio.get_running_loop().time(), self.stats.network_requests + 1
                    if response.status == 200 and len(payload) > 2000:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(gzip.compress(payload, 6))
                        return payload
                    if response.status not in {429, 500, 502, 503, 504}:
                        raise RuntimeError(f"NAR HTTP {response.status}: {url}")
                    retry_after = response.headers.get("Retry-After")
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                retry_after = None
                if attempt == 3:
                    raise RuntimeError(f"NAR取得失敗: {url}: {exc}") from exc
            self.stats.retries += 1
            await asyncio.sleep(min(float(retry_after) if retry_after and retry_after.isdigit() else 20 * 2**attempt, 180))
        raise RuntimeError(f"NAR取得失敗: {url}")


def _write_rows(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def _read_rows(path):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


async def backfill(args):
    if not args.permission_confirmed:
        raise ValueError("NARの許可確認後、--permission-confirmed を付けてください")
    month_url = f"{MONTH_URL}?{urlencode({'k_year': args.year, 'k_month': args.month})}"
    errors, odds_errors, paths = [], [], []
    async with PoliteNarClient(args.work_dir / "cache", args.min_delay, args.max_delay) as client:
        venue_days = parse_schedule_links(await client.fetch(month_url))
        result_links = []
        for i, venue_url in enumerate(venue_days, 1):
            try:
                result_links.extend(parse_result_links(await client.fetch(venue_url)))
            except Exception as exc:
                errors.append({"url": venue_url, "error": str(exc)})
                if not args.continue_on_error: raise
            if i % 25 == 0 or i == len(venue_days):
                print(json.dumps({"venue_days": f"{i}/{len(venue_days)}", "races_found": len(result_links), "errors": len(errors)}, ensure_ascii=False), flush=True)
        result_links = sorted(set(result_links))
        if args.start_day or args.end_day:
            start_day = args.start_day or 1
            end_day = args.end_day or 31
            filtered = []
            for result_url in result_links:
                race_date = _query(result_url, "k_raceDate") or ""
                matched = re.search(r"/(\d{1,2})$", race_date)
                if matched and start_day <= int(matched.group(1)) <= end_day:
                    filtered.append(result_url)
            result_links = filtered
        if args.max_races:
            result_links = result_links[:args.max_races]
        odds_cells, odds_manifests, payout_rows = [], [], []
        for i, url in enumerate(result_links, 1):
            race_key = hashlib.sha256(url.encode()).hexdigest()[:20]
            path = args.work_dir / "events" / str(args.year) / f"{args.month:02d}" / (race_key + ".jsonl.gz")
            paths.append(path)
            if not path.exists():
                try:
                    rows = parse_result_page(await client.fetch(url), url)
                    if not rows: raise ValueError("出走行が0件です")
                    _write_rows(path, rows)
                except Exception as exc:
                    errors.append({"url": url, "error": str(exc)})
                    if not args.continue_on_error: raise
            if path.exists():
                race_rows = _read_rows(path)
                if race_rows:
                    race_id = race_rows[0]["race_id"]
                    try:
                        for payout in json.loads(race_rows[0].get("payouts") or "[]"):
                            payout_rows.append({"race_id": race_id, **payout})
                    except json.JSONDecodeError:
                        pass
                    for bet_type, odds_url in build_odds_urls(url).items():
                        raw_path = args.work_dir / "odds-pages" / str(args.year) / f"{args.month:02d}" / f"{race_key}-{bet_type}.html.gz"
                        try:
                            if raw_path.exists():
                                payload = gzip.decompress(raw_path.read_bytes())
                            else:
                                payload = await client.fetch(odds_url)
                                raw_path.parent.mkdir(parents=True, exist_ok=True)
                                raw_path.write_bytes(gzip.compress(payload, 6))
                            cells = parse_odds_cells(payload, race_id, bet_type, odds_url)
                            odds_cells.extend(cells)
                            odds_manifests.append({
                                "race_id": race_id,
                                "bet_type": bet_type,
                                "source_url": odds_url,
                                "raw_path": str(raw_path),
                                "cells": len(cells),
                            })
                        except Exception as exc:
                            odds_errors.append({"race_id": race_id, "bet_type": bet_type, "url": odds_url, "error": str(exc)})
                            if not args.continue_on_error: raise
            if i == 1 or i % 25 == 0 or i == len(result_links):
                print(json.dumps({"progress": f"{i}/{len(result_links)}", "requests": client.stats.network_requests, "errors": len(errors), "odds_errors": len(odds_errors)}, ensure_ascii=False), flush=True)
        rows = [row for path in paths if path.exists() for row in _read_rows(path)]
        if not rows: raise ValueError("保存できたNARデータがありません")
        frame = pd.DataFrame(rows)
        frame["race_date"] = pd.to_datetime(frame["race_date"])
        frame = frame.sort_values(["race_date", "baba_code", "race_no", "horse_number"]).drop_duplicates(["race_id", "horse_id"])
        winner_counts = frame.assign(_winner=(frame.finish_position == 1).astype(int)).groupby("race_id")["_winner"].transform("sum")
        frame["is_dead_heat"] = winner_counts > 1
        args.output.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(args.output, index=False)
        odds_cells_path = args.output.with_name(args.output.stem + "-odds-cells.parquet")
        odds_manifest_path = args.output.with_name(args.output.stem + "-odds-manifest.parquet")
        payouts_path = args.output.with_name(args.output.stem + "-payouts.parquet")
        if odds_cells:
            pd.DataFrame(odds_cells).drop_duplicates(
                ["race_id", "bet_type", "table_index", "row_index", "cell_index", "text"]
            ).to_parquet(odds_cells_path, index=False)
        if odds_manifests:
            pd.DataFrame(odds_manifests).drop_duplicates(["race_id", "bet_type"]).to_parquet(odds_manifest_path, index=False)
        if payout_rows:
            pd.DataFrame(payout_rows).drop_duplicates(["race_id", "bet_type", "combination"]).to_parquet(payouts_path, index=False)
        report = {"source": "NAR地方競馬情報サイト", "permission_confirmed_by_operator": True,
                  "year": args.year, "month": args.month, "start_day": args.start_day, "end_day": args.end_day,
                  "created_at": datetime.now(timezone.utc).isoformat(),
                  "rows": len(frame), "races": frame.race_id.nunique(), "horses": frame.horse_id.nunique(),
                  "bet_types": list(ODDS_ENDPOINTS), "odds_pages": len(odds_manifests), "odds_cells": len(odds_cells),
                  "payout_rows": len(payout_rows), "venue_days": len(venue_days), "network_requests": client.stats.network_requests,
                  "cache_hits": client.stats.cache_hits, "retries": client.stats.retries, "errors": errors, "odds_errors": odds_errors,
                  "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest()}
        args.output.with_suffix(".audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report


def main():
    parser = argparse.ArgumentParser(description="NAR許諾済み結果・全通常券種最終オッズ・払戻を低負荷で取得")
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--month", type=int, choices=range(1, 13), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("data/raw/nar"))
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=4.0)
    parser.add_argument("--start-day", type=int, choices=range(1, 32))
    parser.add_argument("--end-day", type=int, choices=range(1, 32))
    parser.add_argument("--max-races", type=int)
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--permission-confirmed", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(backfill(args))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["errors"]: raise SystemExit(2)


if __name__ == "__main__": main()
