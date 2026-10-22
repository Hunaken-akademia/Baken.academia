"""Build a provenance-preserving reference index from archived official documents.

Only explicit formats are parsed. Notices are not daily measurements. A missing
year, effective date, segment or value remains missing; no production writes.
"""
import argparse
from collections import Counter
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from lxml import html


def norm(text):
    return unicodedata.normalize("NFKC", text)


def document(raw):
    if re.search(br"charset|encoding=", raw[:4096], re.I):
        return html.fromstring(raw)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp932")
    return html.fromstring(text)


def publication(doc, text):
    for value in doc.xpath("//time/@datetime"):
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T.*)?", value):
            return date.fromisoformat(value[:10]).isoformat()
    # Hyogo and Urawa put the publication date on its own line.
    match = re.search(r"(?m)^\s*(20\d{2})/(\d{1,2})/(\d{1,2})\s*$", text)
    if not match:
        match = re.search(r"(?m)^\s*(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:\([^\n)]*\))?\s*$", text)
    return date(*map(int, match.groups())).isoformat() if match else None


def parse_specification(text, venue, published):
    if venue not in ("浦和", "川崎", "船橋", "門別"):
        return []
    patterns = [r"(?:砂\s*厚\s*[:：]?\s*\(?\s*(?:従来と同様の)?|砂の厚みは従来どおり)(\d+(?:\.\d+)?)\s*(?:cm)?\s*(?:[~〜～]\s*(\d+(?:\.\d+)?)\s*)?cm",
                r"砂厚を調整\(平均\s*(\d+(?:\.\d+)?)\s*cm\)"]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            low = float(match[1])
            high = float(match[2]) if len(match.groups()) > 1 and match[2] else low
            if not 0 < low <= high < 30:
                raise ValueError("Invalid specification range")
            return [dict(venue=venue, metric="sand_depth_cm", kind="announced_specification", value_min=low,
                         value_max=high, publication_date=published, measured_at=None, effective_date=None,
                         evidence=match[0])]
    return []


def parse_iwate(text, title, published):
    if "走路状況" not in title or not published:
        return []
    venue = "盛岡" if "盛岡" in title else "水沢" if "水沢" in title else None
    if not venue or "■" not in text:
        return []
    body = text[text.index("■"):].split("お知らせ一覧")[0]
    result = []
    for match in re.finditer(r"(?:砂厚を|芝高は|含水率[^\d\n]{0,15})(\d+(?:\.\d+)?)\s*(?:cm)?\s*[~〜～-]\s*(\d+(?:\.\d+)?)\s*(cm|%)", body):
        start = max(body.rfind("\n", 0, match.start())+1, body.rfind("。", 0, match.start())+1)
        stop = body.find("。", match.end())
        evidence = body[start:stop+1 if stop >= 0 else match.end()]
        key = "moisture_pct" if match[3] == "%" else "turf_height_cm" if match[0].startswith("芝高") else "sand_depth_cm"
        kind = "management_target" if "目標" in evidence else "forecast" if "見込み" in evidence else "adjustment_notice" if "調整" in evidence else "unclassified_statement"
        low, high = float(match[1]), float(match[2])
        if low > high or not 0 <= low <= high <= 100:
            raise ValueError("Invalid reported range")
        result.append(dict(venue=venue, metric=key, kind=kind, value_min=low, value_max=high,
                           publication_date=published, measured_at=None, effective_date=None, evidence=evidence))
    for keyword, action in [("散水", "watering"), ("芝刈", "mowing"), ("水切りハロー", "drainage_harrow"), ("蹄跡補修", "turf_repair")]:
        if keyword in body:
            result.append(dict(venue=venue, metric="maintenance", kind="maintenance_notice", action=action,
                               publication_date=published, measured_at=None, effective_date=None))
    return result


def parse_hyogo(text, venue, published):
    if venue not in ("園田", "姫路") or "地点の砂厚" not in text:
        return []
    distances = re.search(r"内ラチから\s*1m、\s*3m、\s*5m、\s*7m、\s*10m", text)
    if not distances:
        return []
    asof = re.search(r"【(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日[^】]*現在】", text)
    asof_date = date(*map(int, asof.groups())).isoformat() if asof else None
    result = []
    for segment, sequence in re.findall(r"≪([^≫]+)≫\s*([\d.]+(?:\s*[-ー−]\s*[\d.]+){4})(?![\d.-])", text):
        values = [float(v) for v in re.split(r"\s*[-ー−]\s*", sequence)]
        if len(values) != 5 or not all(0 < value < 30 for value in values):
            raise ValueError("Invalid Hyogo segment profile")
        for distance, value in zip((1, 3, 5, 7, 10), values):
            result.append(dict(venue=venue, metric="sand_depth_cm", kind="reported_track_profile",
                               segment="".join(segment.split()), distance_from_inner_m=distance, value=value,
                               publication_date=published, as_of_date=asof_date, measured_at=None,
                               effective_date=None, evidence=f"≪{segment}≫ {sequence}"))
    return result


def parse_jra_fragment(doc, moisture=False):
    result = []
    for venue in doc.xpath("//*[@title and starts-with(@id,'rc')]"):
        for unit in venue.xpath("./div[contains(concat(' ',normalize-space(@class),' '),' unit ')]"):
            time_text = norm(unit.xpath("string(./div[@class='time'])")).strip()
            cells = unit.xpath("./div[@class='turf' or @class='dirt']/span") if moisture else unit.xpath("./div[@class='cushion']")
            for cell in cells:
                value = cell.text_content().strip()
                if not re.fullmatch(r"\d+(?:\.\d+)?", value):
                    continue
                value = float(value)
                if not 0 <= value <= (100 if moisture else 20):
                    raise ValueError("JRA value outside accepted range")
                result.append(dict(venue=venue.get("title"), metric="moisture_pct" if moisture else "cushion",
                                   kind="measurement_missing_year", value=value, observed_time_text=time_text,
                                   surface=cell.getparent().get("class") if moisture else "turf",
                                   location=cell.get("class") if moisture else None, measured_at=None,
                                   publication_date=None, effective_date=None, year_verified=False))
    return result


def run(inputs, output):
    output.mkdir(parents=True, exist_ok=True)
    sources, failures, candidates, errors, versions = {}, [], [], [], []
    for root in inputs:
        manifest = json.loads((root / "manifest.json").read_text())
        for source in manifest["records"]:
            if source["status"] != "saved":
                failures.append(source)
                continue
            url = source["source_url"]
            if url in sources:
                versions.append(dict(source_url=url, first_sha256=sources[url]["raw_sha256"],
                                     other_sha256=source["raw_sha256"], retrieved_at=source["retrieved_at"],
                                     content_changed=sources[url]["raw_sha256"] != source["raw_sha256"],
                                     selected="first_archived_version"))
                continue
            if re.search(r"404|not found", source.get("title", ""), re.I):
                failures.append(dict(source, status="soft-error"))
                continue
            raw = (root / source["raw_path"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != source["raw_sha256"]:
                raise ValueError(f"Source hash mismatch: {url}")
            record = dict(source, classification="document_only", parsed_records=0)
            sources[url] = record
            if source.get("format") != "html":
                record["classification"] = "attachment_needs_review"
                continue
            try:
                doc = document(raw)
                text = norm("\n".join(line.strip() for line in doc.text_content().splitlines() if line.strip()))
                published = publication(doc, text)
                title = norm(source.get("title", ""))
                rows = []
                if "/news/condition-" in url and "iwatekeiba.or.jp" in url:
                    rows = parse_iwate(text, title, published)
                elif "sonoda-himeji.jp/news/detail/" in url:
                    rows = parse_hyogo(text, source["venue"], published)
                elif source["venue"] in ("浦和", "川崎", "船橋", "門別"):
                    rows = parse_specification(text, source["venue"], published)
                elif url.endswith("/_data_cushion.html") or url.endswith("/_data_moist.html"):
                    rows = parse_jra_fragment(doc, moisture=url.endswith("/_data_moist.html"))
                record.update(publication_date=published, parsed_records=len(rows))
                if rows:
                    record["classification"] = "structured_reference"
                for row in rows:
                    row.update(source_url=url, source_sha256=source["raw_sha256"], retrieved_at=source["retrieved_at"],
                               production_applied=False, prestart_verified=False)
                candidates.extend(rows)
            except Exception as error:
                record["classification"] = "parse_error"
                errors.append(dict(source_url=url, error=str(error)))
    (output / "references.json").write_text(json.dumps(candidates, ensure_ascii=False, indent=2))
    (output / "source-index.json").write_text(json.dumps(list(sources.values()), ensure_ascii=False, indent=2))
    (output / "unavailable.json").write_text(json.dumps(failures, ensure_ascii=False, indent=2))
    (output / "source-versions.json").write_text(json.dumps(versions, ensure_ascii=False, indent=2))
    report = dict(source_documents=len(sources), source_formats=dict(Counter(r["format"] for r in sources.values())),
                  structured_sources=sum(bool(r["parsed_records"]) for r in sources.values()), records=len(candidates),
                  kinds=dict(Counter(r["kind"] for r in candidates)), venues=dict(Counter(r["venue"] for r in candidates)),
                  document_classifications=dict(Counter(r["classification"] for r in sources.values())), parse_errors=errors,
                  production_applied=False, caveats=["Publication dates are not effective dates or measurement times", "Missing years are not inferred", "Not a complete daily history; no forward-fill", "Image/PDF geometry still needs review", "No predictive benefit or causal effect asserted"])
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--input", action="append", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    run(args.input, args.output)
