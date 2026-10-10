"""Attach public JRA result laps and top-three passing orders to known editions.

Only follow result links published in the official annual graded schedule; verify
date, course and distance against the saved edition before accepting a result.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import unicodedata
from urllib.parse import urljoin, urlparse

from lxml import html

BASE = "https://www.jra.go.jp"
AGENT = "Mozilla/5.0 (compatible; REIN/0.4; member analytics)"


def text(node):
    return " ".join(node.text_content().split())


def document(payload):
    value = payload.decode("utf-8", errors="replace")
    if value.count("�") > 20:
        value = payload.decode("cp932", errors="replace")
    return html.fromstring(value)


def fetch(url, cache):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "www.jra.go.jp" or not parsed.path.startswith("/datafile/seiseki/"):
        raise ValueError("Unexpected official result URL")
    path = cache / (hashlib.sha256(url.encode()).hexdigest() + ".html")
    if not path.exists():
        result = subprocess.run(["curl", "--fail", "--silent", "--show-error", "--max-time", "25", "-A", AGENT, url], capture_output=True)
        if result.returncode:
            raise ValueError(f"Official result fetch failed ({result.returncode})")
        path.write_bytes(result.stdout)
    return document(path.read_bytes())


def schedule_links(doc, year):
    links = {}
    for row in doc.xpath("//tr"):
        cells = row.xpath("./th|./td")
        if len(cells) < 8:
            continue
        day = re.search(r"(\d+)月(\d+)日", text(cells[0]))
        distance = re.search(r"([\d,]+)", text(cells[4]))
        results = [a.get("href") for a in row.xpath(".//a[@href]") if "レース結果" in text(a)]
        if not day or not distance or len(results) != 1:
            continue
        surface = "芝" if "芝" in text(cells[4]) else "ダート" if "ダ" in text(cells[4]) else "障害"
        key = (f"{year}-{int(day[1]):02d}-{int(day[2]):02d}", text(cells[2]), surface, int(distance[1].replace(",", "")))
        links.setdefault(key, []).append(urljoin(BASE, results[0]))
    return {k: v[0] for k, v in links.items() if len(v) == 1}


def parse_result(doc, edition, url):
    headers = doc.xpath("//div[contains(concat(' ',normalize-space(@class),' '),' date_line ')]//div[contains(concat(' ',normalize-space(@class),' '),' date ')]")
    value = unicodedata.normalize("NFKC", text(headers[0])) if headers else ""
    y, m, d = map(int, edition["date"].split("-"))
    if not re.search(fr"{y}年\s*{m}月\s*{d}日", value):
        raise ValueError("Result date mismatch")
    courses = doc.xpath("//div[contains(concat(' ',normalize-space(@class),' '),' course ')]")
    course = unicodedata.normalize("NFKC", text(courses[0])) if courses else ""
    distance = re.search(r"([\d,]+)メートル", course)
    surface = "芝" if "芝" in course else "ダート" if "ダート" in course else None
    if not re.search(fr"回{re.escape(edition["venue"])}\d+日", value) or not distance or int(distance[1].replace(",", "")) != edition["distanceM"] or surface != edition["surface"]:
        raise ValueError("Result course mismatch")
    conditions = doc.xpath("//div[contains(concat(' ',normalize-space(@class),' '),' baba ')]//li[@class='turf' or @class='durt']//span[@class='txt']")
    if not conditions or text(conditions[0]) != edition["going"]:
        raise ValueError("Result going mismatch")
    rows = doc.xpath("//tr[td[contains(concat(' ',normalize-space(@class),' '),' place ')]]")
    starters = set()
    for row in rows:
        places = row.xpath("./td[contains(concat(' ',normalize-space(@class),' '),' place ')]")
        numbers = row.xpath("./td[contains(concat(' ',normalize-space(@class),' '),' num ')]")
        if places and numbers and (text(places[0]).isdigit() or text(places[0]) in ("中止", "失格")) and text(numbers[0]).isdigit():
            starters.add(int(text(numbers[0])))
    field_size = len(starters)
    if not 2 <= field_size <= 18:
        raise ValueError("Invalid official starter count")
    runners = []
    for row in rows:
        cell = lambda name: row.xpath(f"./td[contains(concat(' ',normalize-space(@class),' '),' {name} ')]")
        finish = text(cell("place")[0])
        if finish not in ("1", "2", "3"):
            continue
        name, number, corners = cell("horse"), cell("num"), cell("corner")
        if not name or not number or not corners:
            continue
        positions = [int(text(li)) for li in corners[0].xpath(".//li") if text(li).isdigit()]
        stages = [li.get("title", "") for li in corners[0].xpath(".//li") if text(li).isdigit()]
        if any(n < 1 or n > field_size for n in positions):
            raise ValueError("Invalid passing order")
        runners.append({"finish": int(finish), "number": int(text(number[0])), "name": text(name[0]), "corners": positions, "stages": stages})
    if not any(r["finish"] == 1 for r in runners):
        raise ValueError("Official result has no winner")
    laps = []
    for row in doc.xpath("//tr[th]"):
        headings, cells = row.xpath("./th"), row.xpath("./td")
        if headings and cells and "ハロンタイム" in text(headings[0]):
            laps = [float(n) for n in re.findall(r"\d+\.\d+", text(cells[0]))]
    expected = (edition["distanceM"] + 199) // 200
    if len(laps) != expected or any(not 5 <= n <= 30 for n in laps):
        laps = []
    return {"sourceUrl": url, "date": edition["date"], "venue": edition["venue"], "surface": edition["surface"], "distanceM": edition["distanceM"], "going": edition["going"], "fieldSize": field_size, "laps": laps, "runners": runners}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="rein-web/lib/jra-condition-reference.json")
    parser.add_argument("--output", default="rein-web/lib/jra-graded-flow.json")
    parser.add_argument("--cache", default="/tmp/rein-jra-graded-flow")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    cache = Path(args.cache); cache.mkdir(parents=True, exist_ok=True)
    data = json.loads(Path(args.input).read_text())
    years = sorted({e["year"] for r in data["gradedRaces"] for e in r["editions"]})
    schedules, failures = {}, []
    for year in years:
        try:
            schedules[year] = schedule_links(fetch(f"{BASE}/datafile/seiseki/replay/{year}/jyusyo.html", cache), year)
        except Exception as error:
            failures.append({"year": year, "reason": str(error)})
    jobs = []
    for race in data["gradedRaces"]:
        for e in race["editions"]:
            url = schedules.get(e["year"], {}).get((e["date"], e["venue"], e["surface"], e["distanceM"]))
            key = f"{race['key']}|{e['date']}"
            if url:
                jobs.append((key, e, url))
            else:
                failures.append({"key": key, "reason": "Official result link not matched"})
    entries = {}
    def run(job):
        key, edition, url = job
        return key, parse_result(fetch(url, cache), edition, url)
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 4))) as executor:
        futures = {executor.submit(run, job): job for job in jobs}
        for i, future in enumerate(as_completed(futures), 1):
            try:
                key, entry = future.result(); entries[key] = entry
            except Exception as error:
                failures.append({"key": futures[future][0], "reason": str(error)})
            if i % 40 == 0:
                print(json.dumps({"done": i, "total": len(jobs), "accepted": len(entries), "failed": len(failures)}), flush=True)
    payload = {"version": "jra-graded-flow-v1", "generatedAt": datetime.now(timezone.utc).isoformat(), "entries": dict(sorted(entries.items())), "failures": failures}
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({"accepted": len(entries), "laps": sum(bool(e["laps"]) for e in entries.values()), "failures": len(failures)}), flush=True)


if __name__ == "__main__":
    main()
