"""Archive official track references, including attachments, without model updates.

This is a source inventory. Extracted text is NOT a validated measurement series.
Limits, per-host pacing and checkpointed manifests apply even to failed requests.
"""
from __future__ import annotations

import argparse
from collections import Counter, deque
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import time
import unicodedata
from urllib.parse import urldefrag, urljoin, urlsplit

from lxml import html

TERMS = re.compile(r"砂厚|含水率|クッション値|走路状況|馬場整備|砂情報|砂.{0,12}(?:入れ替え|入替|洗浄)|散水|芝刈|馬場概要|ヒーティング|砂障害")


def normalized(text):
    return unicodedata.normalize("NFKC", text)


def allowed(url, hosts):
    parts = urlsplit(url)
    return parts.scheme == "https" and parts.hostname in hosts and not parts.username


def extract_html(raw, url, hosts, attachment_page=False):
    doc = html.fromstring(raw)
    # libxml's default encoding for HTML without a declaration is Latin-1.
    if not re.search(br"charset|encoding=", raw[:4096], re.I):
        doc = html.fromstring(raw.decode("utf-8-sig", errors="replace"))
    title = " ".join(doc.xpath("string(//title)").split())
    content = doc.xpath("//main|//article|//*[@id='main']|//*[@id='contents']")
    root = content[0] if content else doc
    for element in root.xpath(".//script|.//style|.//nav|.//footer|.//header"):
        element.drop_tree()
    text = normalized("\n".join(line.strip() for line in root.text_content().splitlines() if line.strip()))
    links = []
    for a in root.xpath(".//a[@href]"):
        href = urldefrag(urljoin(url, a.get("href")))[0]
        label = normalized(" ".join(a.text_content().split()))
        path = urlsplit(href).path
        relevant = bool(TERMS.search(label)) or bool(re.search(r"/news/condition-|/baba/overview/", path))
        attachment = bool(re.search(r"\.(?:pdf|png|jpe?g)$", path, re.I))
        if allowed(href, hosts) and (relevant or (attachment_page and attachment)):
            links.append({"url": href, "attachment": attachment, "label": label})
    # For a relevant article, preserve inline document images, never global icons.
    if attachment_page:
        for node in root.xpath(".//img[@src]"):
            href = urldefrag(urljoin(url, node.get("src")))[0]
            if allowed(href, hosts) and re.search(r"/(?:news|uploads|upload|topics|resources/images/news)/", href):
                links.append({"url": href, "attachment": True, "label": node.get("alt", "")})
    return title, text, links


def collect(catalog, output, max_pages=180, max_depth=2, interval=3):
    output.mkdir(parents=True, exist_ok=True)
    hosts = set(catalog["allowed_hosts"])
    queue = deque((s["url"], s["venue"], 0, None, s.get("article", False)) for s in catalog["sources"])
    visited, records, blocked, last = set(), [], set(), {}

    def save():
        counts = Counter(r["status"] for r in records)
        manifest = {"retrieved_at": datetime.now(timezone.utc).isoformat(), "research_only": True,
                    "production_applied": False, "max_pages": max_pages, "max_depth": max_depth,
                    "remaining_urls": len(queue), "counts": dict(counts), "records": records,
                    "caveat": "Source documents, not validated daily observations; no forward-fill, no cushion conversion, no inferred dates."}
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    while queue and len(records) < max_pages:
        url, venue, depth, parent, article = queue.popleft()
        if url in visited:
            continue
        visited.add(url)
        host = urlsplit(url).hostname
        record = {"venue": venue, "source_url": url, "parent_url": parent, "depth": depth,
                  "retrieved_at": datetime.now(timezone.utc).isoformat(), "measurement_validated": False}
        if host in blocked:
            record.update(status="host-paused")
            records.append(record)
            save()
            continue
        digest = hashlib.sha256(url.encode()).hexdigest()
        raw_path = output / "raw" / digest
        raw_path.parent.mkdir(exist_ok=True)
        try:
            if not allowed(url, hosts):
                raise ValueError("URL outside official allowlist")
            time.sleep(max(0, interval - (time.monotonic() - last.get(host, 0))))
            last[host] = time.monotonic()
            result = subprocess.run(["curl", "--silent", "--show-error", "--location", "--proto", "=https",
                                     "--proto-redir", "=https", "--max-redirs", "3", "--max-time", "40",
                                     "--max-filesize", "20000000", "--output", str(raw_path),
                                     "--write-out", "%{http_code}\n%{url_effective}", url], capture_output=True, text=True)
            lines = result.stdout.splitlines()
            status = int(lines[0]) if lines and lines[0].isdigit() else 0
            final_url = lines[1] if len(lines) > 1 else url
            record.update(http_status=status, final_url=final_url)
            raw = raw_path.read_bytes() if raw_path.exists() else b""
            record.update(raw_path=str(raw_path.relative_to(output)), raw_sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
            if status in (403, 429, 503):
                blocked.add(host)
            if result.returncode or status != 200:
                raise RuntimeError(f"HTTP {status}; curl {result.returncode}")
            if not allowed(final_url, hosts):
                raise ValueError("Redirect outside official allowlist")
            if raw.startswith(b"%PDF-"):
                import pdfplumber
                with pdfplumber.open(io.BytesIO(raw)) as pdf:
                    text = normalized("\n".join(page.extract_text() or "" for page in pdf.pages))
                    record["pages"] = len(pdf.pages)
                title, links = urlsplit(url).path.rsplit("/", 1)[-1], []
                record["format"] = "pdf" if text.strip() else "image-pdf-needs-review"
            elif urlsplit(url).path.endswith(".json"):
                text = json.dumps(json.loads(raw), ensure_ascii=False, indent=2)
                title, links = urlsplit(url).path.rsplit("/", 1)[-1], []
                record["format"] = "json"
            elif raw.startswith((b"\x89PNG", b"\xff\xd8", b"GIF8")):
                title, text, links = "", "", []
                record["format"] = "image-needs-review"
            else:
                title, text, links = extract_html(raw, final_url, hosts, article)
                record["format"] = "html"
                if re.search(r"404|not found|ページが見つか|アクセスできません", title, re.I):
                    raise RuntimeError("Soft error page returned with HTTP 200")
                if "システムメンテナンス" in title:
                    blocked.add(host)
                    raise RuntimeError("Official system maintenance; host paused")
            text_path = output / "text" / f"{digest}.txt"
            text_path.parent.mkdir(exist_ok=True)
            text_path.write_text(text)
            record.update(status="saved", title=title, text_path=str(text_path.relative_to(output)),
                          matched_terms=sorted(set(TERMS.findall(text))),
                          date_mentions=sorted(set(re.findall(r"(?:20\d{2}[年/.-]\s*\d{1,2}[月/.-]\s*\d{1,2}日?|令和\s*\d+年\s*\d+月\s*\d+日)", text))))
            if depth < max_depth:
                for link in links:
                    queue.append((link["url"], venue, depth+1, url, not link["attachment"]))
            record["discovered_relevant_links"] = len(links)
        except Exception as error:
            record.update(status="error", error=str(error))
        records.append(record)
        print(f'{len(records)}/{max_pages} {venue}: {record["status"]} {url}', flush=True)
        save()
    save()
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=Path("config/track-reference-sources.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-pages", type=int, default=180)
    parser.add_argument("--max-depth", type=int, default=2)
    args = parser.parse_args()
    collect(json.loads(args.catalog.read_text()), args.output, args.max_pages, args.max_depth)
