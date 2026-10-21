"""Sire lookups for JRA history horses from public Yahoo! race cards.

One past race card lists every runner's sire and dam sire, so races are chosen
greedily (newest first) while they still contain an uncollected horse. Horses
whose cards are no longer published fall back to their own horse page.
"""
from __future__ import annotations

import html
import random
import re
import time
import urllib.error
import urllib.request

import pandas as pd

CARD_URL = "https://sports.yahoo.co.jp/keiba/race/denma/{}"
HORSE_URL = "https://sports.yahoo.co.jp/keiba/directory/horse/{}/"
USER_AGENT = "Mozilla/5.0 (compatible; baken-academia-rein/1.0)"


def _key(value: object) -> str:
    return str(value).lstrip("0") or "0"


def _text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def yahoo_race_id(source_cname: str, race_no: int) -> str | None:
    """JRA result cnames carry venue, year, meeting and day: pw01srl10 06 2026 04 04 20260913/75."""
    matched = re.search(r"pw01s\w\w\d{2}(\d{2})(20\d{2})(\d{2})(\d{2})", str(source_cname))
    if not matched:
        return None
    venue, year, meeting, day = matched.groups()
    return f"{year[2:]}{venue}{meeting}{day}{int(race_no):02d}"


def parse_card(page: str) -> dict[str, list[str]]:
    """{horse id: [sire, dam sire]} from a race card; blank names for foreign runners."""
    lineage: dict[str, list[str]] = {}
    for row in re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", page):
        horse = re.search(r"/keiba/directory/horse/(\d+)/", row)
        cell = next((_text(c) for c in re.findall(r"<td[^>]*>([\s\S]*?)</td>", row) if "母父" in c), None)
        if not horse or cell is None:
            continue
        sire = re.search(r"^父[：:]\s*(.*?)\s*母[：:]", cell)
        dam_sire = re.search(r"母父[：:]\s*(.*?)\s*\)", cell)
        lineage[horse.group(1)] = [sire.group(1) if sire else "", dam_sire.group(1) if dam_sire else ""]
    return lineage


def parse_horse(page: str) -> list[str] | None:
    sire = re.search(r'hr-horsePedigree__gen1st--sire">([\s\S]*?)</div>', page)
    second = re.findall(r'hr-horsePedigree__genSecond--(?:sire|dam)">([\s\S]*?)</div>', page)
    if not sire or not _text(sire.group(1)):
        return None
    # Second generation order: sire's sire, sire's dam, dam's sire, dam's dam.
    return [_text(sire.group(1)), _text(second[2]) if len(second) > 2 else ""]


def _get(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        # Retired cards and unknown horses redirect to Yahoo's error pages: treat as gone.
        if "/error/" in (error.url or ""):
            return ""
        raise


def collect(history: pd.DataFrame, store: dict, budget_seconds: float, fetch=_get,
            delay=(3.0, 4.0), clock=time.monotonic, sleep=time.sleep) -> dict[str, object]:
    """Fill store['horses'] within the budget; store['missingCards'] avoids refetching gone cards."""
    horses = store.setdefault("horses", {})
    missing_cards = set(store.setdefault("missingCards", []))
    deadline = clock() + budget_seconds
    requests = cards = singles = failures = 0

    def out_of_time():
        # Count the polite wait before the next request against the budget too.
        return clock() + (delay[0] if requests else 0) >= deadline

    def wait():
        nonlocal requests
        if requests:
            sleep(random.uniform(*delay))
        requests += 1

    races = history.loc[history.horse_id.notna(), ["race_date", "race_id", "race_no", "source_cname", "horse_id"]].copy()
    races["horse"] = races.horse_id.map(_key)
    by_race = races.groupby("race_id", sort=False).agg(date=("race_date", "max"), no=("race_no", "first"),
                                                         cname=("source_cname", "first"), horses=("horse", list))
    for _, race in by_race.sort_values("date", ascending=False).iterrows():
        if out_of_time():
            break
        card = yahoo_race_id(race.cname, race.no)
        if not card or card in missing_cards or all(h in horses for h in race.horses):
            continue
        wait()
        try:
            found = {_key(h): v for h, v in parse_card(fetch(CARD_URL.format(card))).items()}
        except Exception as exc:  # network trouble: retry on the next refresh
            failures += 1
            print("Race card unavailable", card, type(exc).__name__, flush=True)
            continue
        if not any(h in found for h in race.horses):
            missing_cards.add(card)
            continue
        cards += 1
        for horse, lineage in found.items():
            if horse not in horses or not horses[horse][0]:
                horses[horse] = lineage
    # Horses only seen in races whose cards are gone, most starts first.
    starts = races.horse.value_counts()
    for horse in [h for h in starts.index if h not in horses]:
        if out_of_time():
            break
        wait()
        try:
            horses[horse] = parse_horse(fetch(HORSE_URL.format(horse))) or ["", ""]
            singles += 1
        except Exception as exc:
            failures += 1
            print("Horse page unavailable", horse, type(exc).__name__, flush=True)
    store["missingCards"] = sorted(missing_cards)
    remaining = int(sum(h not in horses for h in starts.index))
    return {"requests": requests, "cards": cards, "horsePages": singles, "failures": failures,
            "horses": len(horses), "remaining": remaining}
