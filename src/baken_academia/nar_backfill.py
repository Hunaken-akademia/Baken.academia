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
USER_AGENT = "BakenAcademia-NAR-Backfill/1.0 (licensed; sequential low-rate requests)"


def _text(node) -> str:
    return "" if node is None else " ".join(" ".join(node.xpath(".//text()")).split())


def _first(node, xpath):
    values = node.xpath(xpath)
    return values[0] if values else None


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


def _payouts(doc):
    result, current = [], ""
    for table in doc.xpath("//section[contains(@class,'newRefundTable')]//table"):
        for row in table.xpath(".//tr"):
            current = _text(_first(row, "./td[contains(@class,'title')]")) or current
            combination = _text(_first(row, "./td[contains(@class,'a') or contains(@class,'d')]"))
            money = _int(_text(_first(row, "./td[contains(@class,'refundMoney')]")))
            if current and combination and money is not None:
                result.append({"bet_type": current, "combination": combination, "payout_yen": money,
                               "popularity": _int(_text(_first(row, "./td[contains(@class,'c')]")))})
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
    title = _first(doc, "//section[contains(@class,'raceTitle')]")
    conditions = _text(_first(title, ".//ul[contains(@class,'dataArea')]/li[1]"))
    distance_match = re.search(r"(\d+)\s*ｍ", conditions)
    direction_match = re.search(r"ｍ（([^）]+)）", conditions)
    weather_match = re.search(r"天候[：:]\s*([^\s]+)", conditions)
    going_match = re.search(r"馬場[：:]\s*([^\s]+)", conditions)
    payout_json = json.dumps(_payouts(doc), ensure_ascii=False)
    rows = []
    table = _first(doc, "//section[contains(@class,'gradeTable')]/table")
    if table is None:
        return rows
    for runner in table.xpath(".//tr[td]"):
        horse = _first(runner, "./td[contains(@class,'horseName')]//a")
        if horse is None:
            continue
        jockey = _first(runner, "./td[contains(@class,'jockeyName')]//a")
        trainer = _first(runner, ".//a[contains(@class,'trainerName')]")
        sex_age = re.search(r"(せん|牡|牝)\s*(\d+)", _text(_first(runner, "./td[contains(@class,'f')]")))
        weight_text = _text(_first(runner, "./td[contains(@class,'horseWeight') ]"))
        weight = re.search(r"(\d+)\s*\(([+-]?\d+)\)", weight_text)
        finish = _text(_first(runner, "./td[contains(@class,'a')]"))
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
            "gate": _int(_text(_first(runner, "./td[contains(@class,'b')]"))),
            "horse_number": _int(_text(_first(runner, "./td[contains(@class,'c')]"))),
            "horse_id": _query(horse.get("href"), "k_lineageLoginCode"), "horse_name": _text(horse),
            "affiliation": _text(_first(runner, "./td[contains(@class,'e')]")) or None,
            "sex": sex_age.group(1) if sex_age else None, "age": int(sex_age.group(2)) if sex_age else None,
            "weight_carried": _float(_text(_first(runner, "./td[contains(@class,'g')]"))),
            "jockey_id": _query(jockey.get("href") if jockey is not None else None, "k_riderLicenseNo"),
            "jockey_name": _text(jockey).split("（")[0].strip() if jockey is not None else None,
            "trainer_id": _query(trainer.get("href") if trainer is not None else None, "k_trainerLicenseNo"),
            "trainer_name": _text(trainer) or None,
            "horse_weight": int(weight.group(1)) if weight else _int(weight_text),
            "horse_weight_change": int(weight.group(2)) if weight else None,
            "finish_time": _text(_first(runner, "./td[contains(@class,'k')]")) or None,
            "margin": _text(_first(runner, "./td[contains(@class,'l')]")) or None,
            "last_3f": _float(_text(_first(runner, "./td[contains(@class,'m')]"))),
            "popularity": _int(_text(_first(runner, "./td[contains(@class,'o')]"))),
            "win_odds": _float(_text(_first(runner, "./td[contains(@class,'p')]"))),
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
    errors, paths = [], []
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
        result_links = sorted(set(result_links))[:args.max_races] if args.max_races else sorted(set(result_links))
        for i, url in enumerate(result_links, 1):
            path = args.work_dir / "events" / str(args.year) / f"{args.month:02d}" / (hashlib.sha256(url.encode()).hexdigest()[:20] + ".jsonl.gz")
            paths.append(path)
            if not path.exists():
                try:
                    rows = parse_result_page(await client.fetch(url), url)
                    if not rows: raise ValueError("出走行が0件です")
                    _write_rows(path, rows)
                except Exception as exc:
                    errors.append({"url": url, "error": str(exc)})
                    if not args.continue_on_error: raise
            if i == 1 or i % 50 == 0 or i == len(result_links):
                print(json.dumps({"progress": f"{i}/{len(result_links)}", "requests": client.stats.network_requests, "errors": len(errors)}, ensure_ascii=False), flush=True)
        rows = [row for path in paths if path.exists() for row in _read_rows(path)]
        if not rows: raise ValueError("保存できたNARデータがありません")
        frame = pd.DataFrame(rows)
        frame["race_date"] = pd.to_datetime(frame["race_date"])
        frame = frame.sort_values(["race_date", "baba_code", "race_no", "horse_number"]).drop_duplicates(["race_id", "horse_id"])
        winner_counts = frame.assign(_winner=(frame.finish_position == 1).astype(int)).groupby("race_id")["_winner"].transform("sum")
        frame["is_dead_heat"] = winner_counts > 1
        args.output.parent.mkdir(parents=True, exist_ok=True)
        frame.to_parquet(args.output, index=False)
        report = {"source": "NAR地方競馬情報サイト", "permission_confirmed_by_operator": True,
                  "year": args.year, "month": args.month, "created_at": datetime.now(timezone.utc).isoformat(),
                  "rows": len(frame), "races": frame.race_id.nunique(), "horses": frame.horse_id.nunique(),
                  "venue_days": len(venue_days), "network_requests": client.stats.network_requests,
                  "cache_hits": client.stats.cache_hits, "retries": client.stats.retries, "errors": errors,
                  "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest()}
        args.output.with_suffix(".audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report


def main():
    parser = argparse.ArgumentParser(description="NAR許諾済み結果を低負荷で月単位取得")
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--month", type=int, choices=range(1, 13), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("data/raw/nar"))
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=4.0)
    parser.add_argument("--max-races", type=int)
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--permission-confirmed", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(backfill(args))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["errors"]: raise SystemExit(2)


if __name__ == "__main__": main()
