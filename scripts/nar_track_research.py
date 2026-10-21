"""Official NAR track measurements and retrospective research; never activates a model.

Sand thickness (cm) is not a turf cushion index. Publication targets are not
measurements. Missing dates are never forward-filled. Historical posts may have
been revised: this is a retrospective study, not a verified prestart backtest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from lxml import html

KOCHI = "https://www.keiba.or.jp/"
SEGMENTS = {"turn12": "1から2コーナー", "back": "向正面", "turn34": "3から4コーナー", "home": "正面"}


def fetch(url, path):
    if path.exists():
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    time.sleep(3)
    part = path.with_suffix(path.suffix + ".part")
    subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "60", "--retry", "2", url, "--output", str(part)], check=True)
    part.replace(path)
    return path.read_bytes()


def parse_kochi_post(post):
    text = unicodedata.normalize("NFKC", html.fromstring(post["content"]["rendered"] or "<p/>").text_content())
    title = unicodedata.normalize("NFKC", html.fromstring("<p>" + post["title"]["rendered"] + "</p>").text_content())
    date_pattern = r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日"
    date = re.search(date_pattern, title) or re.search(date_pattern, text)
    if not date:
        return None
    day = f"{int(date[1]):04}-{int(date[2]):02}-{int(date[3]):02}"
    measured = re.search(r"(\d{1,2})時\s*(?:(\d{1,2})分)?\s*現在", text)
    going = re.search(r"馬場状態\s*[ :：]*\s*(不良|稍重|重|良)", text)
    sections = {}
    for key, label in SEGMENTS.items():
        # Require an entire numeric sequence immediately after the segment label.
        match = re.search(re.escape(label) + r"(?:\s*[（(][^）)]*[）)])?\s*([\d.]+(?:\s*[-ー−–]\s*[\d.]+){3,})", text)
        if match:
            values = [float(v) for v in re.findall(r"\d+(?:\.\d+)?", match[1])]
            if not all(0 < v < 30 for v in values):
                raise ValueError(f"Invalid sand depth: {post['link']}")
            sections[key] = values
    if len(sections) != 4:
        return None
    measured_at = f"{day}T{int(measured[1]):02}:{int(measured[2] or 0):02}:00+09:00" if measured else None
    published = post.get("date")
    published_at = published + "+09:00" if published else None
    available = max(filter(None, (measured_at, published_at)), default=None)
    inner = [values[0] for values in sections.values()]
    outer = [v for values in sections.values() for v in values[2:]]
    return {"venue": "高知", "date": day, "going_at_measurement": going[1] if going else None,
            "measured_at": measured_at, "published_at": published_at, "available_after": available,
            "modified_at": post.get("modified"), "sand_cm_by_segment": sections,
            "inner_mean_cm": sum(inner) / len(inner), "outer_mean_cm": sum(outer) / len(outer),
            "inner_outer_gap_cm": sum(inner) / len(inner) - sum(outer) / len(outer),
            "source_url": post["link"], "post_id": post["id"], "cushion": None,
            "source_sha256": hashlib.sha256(post["content"]["rendered"].encode()).hexdigest()}


def collect(out, since="2019-01-01"):
    rows, excluded, pages = [], [], 0
    for page in range(1, 101):
        query = urlencode({"rest_route": "/wp/v2/posts", "categories": 36, "per_page": 100, "page": page,
                           "after": since + "T00:00:00", "_fields": "id,date,modified,link,title,content"})
        payload = json.loads(fetch(KOCHI + "?" + query, out / "raw" / f"kochi-{since}-{page}.json"))
        if not isinstance(payload, list):
            raise ValueError("Unexpected official REST response")
        pages += 1
        for post in payload:
            try:
                record = parse_kochi_post(post)
                if record:
                    rows.append(record)
                else:
                    excluded.append({"url": post["link"], "reason": "no complete dated four-segment numeric measurement"})
            except ValueError as e:
                excluded.append({"url": post["link"], "reason": str(e)})
        print(f"Kochi page {page}: {len(rows)} measurements, {len(excluded)} exclusions", flush=True)
        if len(payload) < 100:
            break
    else:
        raise RuntimeError("Pagination safety limit reached")
    # Preserve separate announcements on the same date; do not overwrite revisions.
    rows.sort(key=lambda r: (r["date"], r["published_at"] or "", r["post_id"]))
    out.mkdir(parents=True, exist_ok=True)
    (out / "kochi-measurements.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    coverage = {"retrieved_at": datetime.now(timezone.utc).isoformat(), "pages": pages, "measurements": len(rows),
                "days": len({r['date'] for r in rows}), "from": min((r['date'] for r in rows), default=None),
                "through": max((r['date'] for r in rows), default=None), "excluded": excluded,
                "historical_revision_caveat": True}
    (out / "collection.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2))
    collect_other_sources(out)
    return rows


def collect_other_sources(out):
    """Inventory notices separately; never silently expand an event to daily values."""
    sources = [
        ("名古屋", "https://www.nagoyakeiba.com/info/race/dirt_course/index.html", "maintenance-events"),
        ("門別", "https://www.hokkaidokeiba.net/topics/main.php?p_tcd=0000007623", "dated-sand-adjustment"),
        ("盛岡", "https://www.iwatekeiba.or.jp/news/condition-250806", "sand-adjustment-and-management-target"),
    ]
    inventory = []
    for venue, url, kind in sources:
        raw = fetch(url, out / "raw" / f"{venue}-source.html")
        doc = html.fromstring(raw)
        events = []
        if venue == "名古屋":
            for row in doc.xpath("//table//tr[td]"):
                cells = [" ".join(td.text_content().split()) for td in row.xpath("./td")]
                if len(cells) >= 3 and re.fullmatch(r"\d{4}年\d{2}月\d{2}日", cells[0]):
                    events.append({"date": cells[0], "action": cells[1], "segment": cells[2]})
        inventory.append({"venue": venue, "url": url, "kind": kind, "events": events,
                          "raw_sha256": hashlib.sha256(raw).hexdigest(), "cushion": None,
                          "daily_measurement_series": False, "used_in_outcome_analysis": False,
                          "note": "原文の整備・調整情報。日別実測への補完・換算はしない。含水率の管理目標は実測ではない。"})
    (out / "other-source-inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2))


def prior_styles(frame):
    """Use the previous five known first-corner ranks, strictly before the date.

    Relative front <= 1/3; middle <= 2/3; rear > 2/3. At least two observed
    starts are required. The current race's position is never an input.
    """
    import pandas as pd
    work = frame.copy()
    fields = work.groupby("race_id").horse_number.transform("size")
    def first(value):
        if not isinstance(value, str) or not re.fullmatch(r"\d{1,2}(?:-\d{1,2}){1,3}", value.strip()):
            return float("nan")
        return float(value.split("-")[0])
    work["_position"] = work.corner_positions.map(first) / fields
    work.loc[~work._position.between(0, 1, inclusive="right"), "_position"] = float("nan")
    work["prior_style"] = "unknown"
    for _, group in work.loc[work.horse_id.notna() & work.horse_id.ne("")].groupby("horse_id"):
        history = []
        for _, day in group.sort_values(["race_date", "race_id"]).groupby("race_date", sort=False):
            if len(history) >= 2:
                mean = sum(history[-5:]) / len(history[-5:])
                work.loc[day.index, "prior_style"] = "front" if mean <= 1 / 3 else "middle" if mean <= 2 / 3 else "rear"
            history.extend(day._position.dropna().tolist())
    return work.drop(columns="_position")


def analyze(input_dir, measurements, out):
    import numpy as np
    import pandas as pd
    frames = []
    for path in sorted(input_dir.rglob("*.parquet")):
        frame = pd.read_parquet(path)
        if "baba_code" not in frame:
            continue
        # Keep the entire acquired population for each horse's prior-style history.
        frames.append(frame)
    if not frames:
        raise ValueError("No acquired race records")
    data = pd.concat(frames, ignore_index=True)
    data["race_date"] = pd.to_datetime(data.race_date).dt.strftime("%Y-%m-%d")
    data = data.drop_duplicates(["race_id", "horse_number"]).sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    if "corner_positions" not in data:
        data["corner_positions"] = None
    data = prior_styles(data)
    target = data.loc[pd.to_numeric(data.baba_code, errors="coerce").eq(31)].copy()
    rows = json.loads(measurements.read_text())
    days = pd.DataFrame(rows).sort_values(["date", "published_at"]).drop_duplicates("date", keep="first")
    joined = target.merge(days, left_on="race_date", right_on="date", how="left", validate="many_to_one")
    # Fixed buckets before inspecting outcomes; no future quantiles or optimization.
    joined["depth_band"] = pd.cut(joined.inner_outer_gap_cm, [-np.inf, 1, 2, np.inf], labels=["gap<=1cm", "gap1-2cm", "gap>2cm"]).astype("object")
    joined["period"] = np.where(joined.race_date.lt("2025-01-01"), "history", np.where(joined.race_date.lt("2026-01-01"), "2025", "2026"))
    eligible = joined.loc[joined.date.notna() & joined.finish_position.notna() & joined.prior_style.ne("unknown") & joined.race_date.ge("2025-01-01")].copy()
    summary = []
    for keys, part in eligible.groupby(["period", "depth_band", "going", "prior_style"], dropna=False, observed=True):
        summary.append({"period": str(keys[0]), "depth_band": str(keys[1]), "going": str(keys[2]), "style": str(keys[3]),
                        "starts": len(part), "races": part.race_id.nunique(), "days": part.race_date.nunique(),
                        "wins": int(part.finish_position.eq(1).sum()), "top3": int(part.finish_position.between(1, 3).sum()),
                        "win_rate": float(part.finish_position.eq(1).mean()), "top3_rate": float(part.finish_position.between(1, 3).mean())})
    report = {"status": "descriptive-only" if len(eligible) else "insufficient-prior-corners", "production_applied": False,
              "records": len(data), "kochi_races": target.race_id.nunique(), "kochi_starts": len(target),
              "matched_races": joined.loc[joined.date.notna()].race_id.nunique(), "matched_days": joined.loc[joined.date.notna()].race_date.nunique(),
              "known_prior_style_starts": len(eligible), "groups": summary,
              "limitations": ["砂厚はクッション値ではない", "現時点の公式記事の再取得。過去の改訂履歴と発走前公開を検証していない", "同日一致のみ。欠測日の前方補完なし", "当日の通過順から脚質を作らず、前日以前の最大5走を使用", "枠順は実際の内外走行位置ではない", "記述集計であり、因果効果・予測改善・回収率を示さない", "距離・クラス・人気・季節による交絡が残る。予想補正は未採用"]}
    coverage_path = out / "corner-collection.json"
    if coverage_path.exists():
        coverage = json.loads(coverage_path.read_text())
        report["passing_order_coverage"] = {"planned_races": coverage["planned_races"], "completed_races": coverage["completed_races"],
                                             "pilot": coverage["pilot"], "errors": sum(r["status"] == "error" for r in coverage["records"])}
        report["limitations"].append("通過順の補完対象は高知の過去出走。高知以外の出走からは脚質履歴を補わない")
        if len(eligible) and (coverage["pilot"] or coverage["completed_races"] < coverage["planned_races"] or report["passing_order_coverage"]["errors"]):
            report["status"] = "descriptive-partial"
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    joined.to_parquet(out / "kochi-joined.parquet", index=False)
    lines = ["# 地方馬場研究・高知", f"対象 {report['kochi_races']:,}レース / 砂厚一致 {report['matched_races']:,}レース・{report['matched_days']}日 / 過去通過順から脚質を分類できた {len(eligible):,}走", f"状態: {report['status']}。予想補正への反映なし。", "", "2025年と2026年を分けた記述集計。各分類の母数は report.json を参照。", "", *["- " + s for s in report["limitations"]]]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "groups"}, ensure_ascii=False), flush=True)
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--since", default="2019-01-01")
    p.add_argument("--input-dir", type=Path)
    p.add_argument("--measurements", type=Path)
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.input_dir:
        analyze(args.input_dir, args.measurements, args.output)
    else:
        collect(args.output, args.since)
