"""Past-edition trends for each JRA graded race, for the REIN race screen.

For every graded race in rein-web/lib/jra-condition-reference.json, every runner of
its editions up to --through-year is described only with facts known before that
race (previous JRA start, earlier wins, earlier rides) and grouped the way the
trend cards show them: 1-2-3-other counts per bucket. History starts in 2019, so
"before the race" means within the JRA history from 2019.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jra_condition_reference import grade_from_row, normalized_text, race_name_key  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from baken_academia.rein_history import _key  # noqa: E402

VERSION = "jra-graded-trends-v1"


def _corner(value: object, index: int) -> int | None:
    try:
        positions = json.loads(value) if isinstance(value, str) and value else []
    except json.JSONDecodeError:
        return None
    numbers = [int(m.group()) for p in positions if (m := re.search(r"\d+", str(p)))]
    return numbers[index] if numbers else None


def prepare(raw: pd.DataFrame) -> pd.DataFrame:
    d = raw.copy()
    d["race_date"] = pd.to_datetime(d["race_date"])
    for column in ("finish_position", "popularity", "gate", "horse_number", "age", "horse_weight", "avg_1f", "distance_m"):
        d[column] = pd.to_numeric(d.get(column), errors="coerce")
    d["horse"] = d["horse_id"].map(_key)
    d["venue"] = d["racecourse"].map(normalized_text)
    d["jockey"] = d["jockey_id"].map(lambda v: _key(v) if pd.notna(v) else "")
    d["name_key"] = d["race_name"].map(race_name_key)
    d["race_grade"] = d.apply(grade_from_row, axis=1)
    d["corner4"] = d["corner_positions"].map(lambda v: _corner(v, -1))
    # 上がり3F (JRA's 推定上り, stored as avg_1f) ranked within each race among finishers.
    finished = d["finish_position"].notna() & d["avg_1f"].gt(0)
    d["last3f_rank"] = d["avg_1f"].where(finished).groupby(d["race_id"]).rank(method="min")
    d = d.sort_values(["horse", "race_date", "race_id"]).reset_index(drop=True)
    by_horse = d.groupby("horse", sort=False)
    for column in ("race_date", "name_key", "race_grade", "finish_position", "jockey"):
        d[f"prev_{column}"] = by_horse[column].shift(1)
    # Facts strictly before this start, within the history.
    g1_win = (d["race_grade"].eq("G1") & d["finish_position"].eq(1)).astype(int)
    d["g1_wins_before"] = g1_win.groupby(d["horse"]).cumsum() - g1_win
    d["ride_index"] = d.groupby(["horse", "jockey"]).cumcount()
    return d


def bucket(value, edges):
    if pd.isna(value):
        return None
    for label, test in edges:
        if test(value):
            return label
    return None


POPULARITY = [("1番人気", lambda v: v == 1), ("2番人気", lambda v: v == 2), ("3番人気", lambda v: v == 3),
              ("4〜6番人気", lambda v: v <= 6), ("7〜9番人気", lambda v: v <= 9), ("10番人気以下", lambda v: True)]
LAST3F = [("上がり1位", lambda v: v == 1), ("上がり2〜3位", lambda v: v <= 3), ("上がり4〜5位", lambda v: v <= 5), ("上がり6位以下", lambda v: True)]
CORNER4 = [("4角1〜3番手", lambda v: v <= 3), ("4角4〜7番手", lambda v: v <= 7), ("4角8〜11番手", lambda v: v <= 11), ("4角12番手以下", lambda v: True)]
PREV_FINISH = [("前走1着", lambda v: v == 1), ("前走2〜3着", lambda v: v <= 3), ("前走4〜5着", lambda v: v <= 5), ("前走6着以下", lambda v: True)]
INTERVAL = [("中4週以内", lambda v: v <= 35), ("中5〜9週", lambda v: v <= 70), ("中10週以上", lambda v: True)]
AGE = [("3歳", lambda v: v <= 3), ("4歳", lambda v: v == 4), ("5歳", lambda v: v == 5), ("6歳", lambda v: v == 6), ("7歳以上", lambda v: True)]
WEIGHT = [("459kg以下", lambda v: v <= 459), ("460〜479kg", lambda v: v <= 479), ("480〜499kg", lambda v: v <= 499), ("500kg以上", lambda v: True)]
PAIRING = [("初コンビ", lambda v: v == 0), ("2〜3戦目", lambda v: v <= 2), ("4戦目以上", lambda v: True)]


def record(rows: pd.DataFrame) -> list[int]:
    f = rows["finish_position"]
    return [int((f == 1).sum()), int((f == 2).sum()), int((f == 3).sum()), int((~f.between(1, 3)).sum())]


def section(runners: pd.DataFrame, title: str, note: str, labels: pd.Series, order: list[str]) -> dict:
    rows = []
    for label in order:
        part = runners.loc[labels.eq(label)]
        if len(part):
            rows.append({"label": label, "record": record(part)})
    return {"title": title, "note": note, "rows": rows}


def lineage_table(runners: pd.DataFrame, column: str, limit: int = 10) -> list[dict]:
    named = runners.loc[runners[column].ne("")]
    table = [{"name": name, "record": record(group)} for name, group in named.groupby(column, sort=False)]
    table.sort(key=lambda r: (-(r["record"][0] + r["record"][1] + r["record"][2]), -r["record"][0], -sum(r["record"]), r["name"]))
    return table[:limit]


def edition_rows(d: pd.DataFrame, edition: dict, key: str) -> pd.DataFrame:
    same = d.loc[d["race_date"].eq(pd.Timestamp(edition["date"])) & d["venue"].eq(edition["venue"])
                 & d["surface"].eq(edition["surface"]) & d["distance_m"].eq(edition["distanceM"])]
    races = list(same.groupby("race_id", sort=False))
    if len(races) > 1:
        # Two races with the same course on one day: keep the one named like this graded race.
        races = [r for r in races if r[1]["name_key"].iloc[0] == key
                 or SequenceMatcher(None, r[1]["name_key"].iloc[0], key).ratio() >= 0.5] or races
    return races[0][1] if len(races) == 1 else same.iloc[0:0]


SCRATCHED = {"取消", "除外"}


def build_race(d: pd.DataFrame, entry: dict, pedigree: dict, through_year: int, starts: dict) -> dict | None:
    editions = [e for e in entry["editions"] if e["year"] <= through_year]
    frames = []
    for e in editions:
        rows = edition_rows(d, e, entry["key"])
        # Scratched horses did not run; 中止・失格 stay in as unplaced starters.
        rows = rows.loc[rows["finish_position"].notna() | ~rows["finish_status"].isin(SCRATCHED)]
        if len(rows):
            frames.append(rows.assign(edition_year=e["year"], edition_going=e.get("going") or "", field_size=len(rows)))
    if len(frames) < 5:
        return None
    runners = pd.concat(frames, ignore_index=True)
    runners = runners.copy()
    ped = runners["horse"].map(lambda h: pedigree.get(h) or ["", ""])
    runners["sire"], runners["dam_sire"] = ped.map(lambda p: p[0] or ""), ped.map(lambda p: (p[1] if len(p) > 1 else "") or "")
    interval = (runners["race_date"] - runners["prev_race_date"]).dt.days
    last = editions[-1]
    course = (last["venue"], last["surface"], last["distanceM"])

    def course_record(row):
        mine = starts.get(row.horse)
        before = mine.loc[mine["race_date"].lt(row.race_date) & mine["venue"].eq(course[0]) & mine["surface"].eq(course[1])
                          & mine["distance_m"].eq(course[2])] if mine is not None else d.iloc[0:0]
        return "初出走" if before.empty else "3着内あり" if before["finish_position"].between(1, 3).any() else "走ったが3着内なし"

    prev_name = runners["prev_name_key"].fillna("")
    common = prev_name.loc[prev_name.ne("")].value_counts()
    top_prev = [name for name, count in common.items() if count >= 3][:6]
    prev_label = prev_name.map(lambda n: n if n in top_prev else ("その他" if n else None))
    prev_grade = runners["prev_race_grade"].map(lambda g: "前走G1" if g == "G1" else "前走G2" if g == "G2" else "前走G3以下")
    prev_grade = prev_grade.where(prev_name.ne(""))
    sections = [
        section(runners, "人気別", "確定人気", runners["popularity"].map(lambda v: bucket(v, POPULARITY)), [b for b, _ in POPULARITY]),
        section(runners, "上がり3ハロンの順位", "レース内での順位", runners["last3f_rank"].map(lambda v: bucket(v, LAST3F)), [b for b, _ in LAST3F]),
        section(runners, "枠別", "", runners["gate"].map(lambda v: f"{int(v)}枠" if pd.notna(v) else None), [f"{i}枠" for i in range(1, 9)]),
        section(runners, "4コーナーの位置", "4コーナー通過順", runners["corner4"].map(lambda v: bucket(v, CORNER4)), [b for b, _ in CORNER4]),
        section(runners, "前走のレース", "JRAの前走", prev_label, top_prev + ["その他"]),
        section(runners, "前走の格", "", prev_grade, ["前走G1", "前走G2", "前走G3以下"]),
        section(runners, "前走の着順", "", runners["prev_finish_position"].map(lambda v: bucket(v, PREV_FINISH)), [b for b, _ in PREV_FINISH]),
        section(runners, "前走からの間隔", "", interval.map(lambda v: bucket(v, INTERVAL)), [b for b, _ in INTERVAL]),
        section(runners, "年齢", "", runners["age"].map(lambda v: bucket(v, AGE)), [b for b, _ in AGE]),
        section(runners, "性別", "", runners["sex"].map(lambda s: "牝馬" if s == "牝" else "牡馬・セン馬" if isinstance(s, str) and s else None), ["牡馬・セン馬", "牝馬"]),
        section(runners, "GI勝ちの実績", "2019年以降のJRA GI", runners["g1_wins_before"].map(lambda v: "GI勝ちあり" if v > 0 else "GI勝ちなし"), ["GI勝ちあり", "GI勝ちなし"]),
        section(runners, f"{course[0]}{course[1]}{course[2]}mの実績", "このコースで3着以内があるか",
                pd.Series([course_record(r) for r in runners.itertuples()], index=runners.index), ["3着内あり", "走ったが3着内なし", "初出走"]),
        section(runners, "騎手", "前走と同じ騎手か", pd.Series(
            ["前走と同じ騎手" if p and p == j else "乗り替わり" if p else None for p, j in zip(runners["prev_jockey"].fillna(""), runners["jockey"])],
            index=runners.index), ["前走と同じ騎手", "乗り替わり"]),
        section(runners, "騎手との相性", "この馬に乗るのは何戦目か", runners["ride_index"].map(lambda v: bucket(v, PAIRING)), [b for b, _ in PAIRING]),
        section(runners, "馬体重", "当日の馬体重", runners["horse_weight"].map(lambda v: bucket(v, WEIGHT)), [b for b, _ in WEIGHT]),
    ]
    fav = runners.loc[runners["popularity"].eq(1)]
    results = []
    for year, group in runners.groupby("edition_year", sort=True):
        placed = group.loc[group["finish_position"].between(1, 3)].sort_values("finish_position")
        results.append({"year": int(year), "going": group["edition_going"].iloc[0], "field": int(group["field_size"].iloc[0]), "rows": [{
            "finish": int(r.finish_position), "name": normalized_text(r.horse_name), "sexAge": f"{r.sex or ''}{int(r.age) if pd.notna(r.age) else ''}",
            "sire": r.sire, "popularity": int(r.popularity) if pd.notna(r.popularity) else None,
            "prior": f"{r.prev_name_key} {int(r.prev_finish_position)}着" if isinstance(r.prev_name_key, str) and r.prev_name_key and pd.notna(r.prev_finish_position) else "",
            "corner4": int(r.corner4) if pd.notna(r.corner4) else None, "last3fRank": int(r.last3f_rank) if pd.notna(r.last3f_rank) else None,
        } for r in placed.itertuples()]})
    years = sorted(runners["edition_year"].unique())
    venues = {(e["venue"], e["surface"], e["distanceM"]) for e in editions}
    return {
        "key": entry["key"], "name": entry["name"], "grade": editions[-1]["grade"], "yearFrom": int(years[0]), "yearTo": int(years[-1]),
        "editions": len(years), "course": f"{course[0]} {course[1]}{course[2]}m", "courseChanged": len(venues) > 1,
        "summary": {"favorite": record(fav), "winnersPopularity4Plus": int((runners["finish_position"].eq(1) & runners["popularity"].ge(4)).sum()),
                    "maxWinnerPopularity": int(runners.loc[runners["finish_position"].eq(1), "popularity"].max())},
        "sections": [s for s in sections if s["rows"]],
        "sires": lineage_table(runners, "sire"), "damSires": lineage_table(runners, "dam_sire"), "results": results,
    }


def build(raw: pd.DataFrame, reference: dict, pedigree: dict, through_year: int) -> dict:
    d = prepare(raw)
    starts = {horse: group for horse, group in d.groupby("horse", sort=False)}
    races = [r for r in (build_race(d, entry, pedigree, through_year, starts) for entry in reference["gradedRaces"]) if r]
    return {"version": VERSION, "throughYear": through_year, "dateFrom": str(d["race_date"].min().date()),
            "races": {r["key"]: r for r in races},
            "limitations": ["前走・GI勝ち・コース実績・騎乗回数は2019年以降のJRAのレースだけで判定（海外・地方の前走は含まない）。",
                            "人気は確定人気。過去の集計で、今回の的中確率ではない。"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--pedigree", type=Path)
    parser.add_argument("--through-year", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pedigree = json.loads(args.pedigree.read_text()).get("horses", {}) if args.pedigree else {}
    payload = build(pd.read_parquet(args.history), json.loads(args.reference.read_text()), pedigree, args.through_year)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"races": len(payload["races"]), "bytes": args.output.stat().st_size,
                      "withSires": sum(1 for r in payload["races"].values() if r["sires"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
