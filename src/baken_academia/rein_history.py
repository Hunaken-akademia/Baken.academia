from __future__ import annotations

import argparse
import gzip
import html
import json
import re
import unicodedata
from pathlib import Path

import pandas as pd


def _key(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).lstrip("0") or "0"


def lineage_name(value: object) -> str:
    """Sire key shared with the web runtime: race cards and horse pages differ only in spacing."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", html.unescape(str(value or ""))))


def _pair_counts(frame: pd.DataFrame) -> dict[str, list[int]]:
    """Exact horse x jockey records [starts, 1st, 2nd, 3rd] for horses that ran in the last two years."""
    valid = frame.loc[frame["finish_position"].notna() & frame["jockey_id"].notna()]
    active = valid.loc[valid["race_date"] >= valid["race_date"].max() - pd.Timedelta(days=730), "horse_id"].unique()
    valid = valid.loc[valid["horse_id"].isin(active)]
    grouped = valid.groupby(["horse_id", "jockey_id"], observed=True).finish_position.agg(
        n="size", w=lambda x: int((x == 1).sum()), s=lambda x: int((x == 2).sum()), t=lambda x: int((x == 3).sum()))
    return {f"{_key(h)}|{_key(j)}": [int(r.n), int(r.w), int(r.s), int(r.t)] for (h, j), r in grouped.iterrows()}


def _rate_profile(frame: pd.DataFrame, keys: list[str]) -> dict[str, dict[str, float | int]]:
    valid = frame.loc[frame["finish_position"].notna()].copy()
    valid["win"] = valid["finish_position"].eq(1).astype(int)
    valid["top3"] = valid["finish_position"].between(1, 3).astype(int)
    grouped = valid.groupby(keys, observed=True, dropna=False).agg(
        starts=("finish_position", "size"),
        wins=("win", "sum"),
        top3=("top3", "sum"),
        avg_finish=("finish_position", "mean"),
    )
    result: dict[str, dict[str, float | int]] = {}
    for index, row in grouped.iterrows():
        parts = index if isinstance(index, tuple) else (index,)
        compound = "|".join(_key(part) for part in parts)
        starts = int(row["starts"])
        result[compound] = {
            "n": starts,
            "w": round(float((row["wins"] + 1.5) / (starts + 20)), 5),
            "t": round(float((row["top3"] + 4.5) / (starts + 20)), 5),
            "f": round(float(row["avg_finish"]), 3),
        }
    return result


def build(input_path: Path, output_path: Path, pedigree: dict[str, list[str]] | None = None,
          pairs: bool = False, extras: dict[str, object] | None = None) -> dict[str, object]:
    df = pd.read_parquet(input_path)
    df["race_date"] = pd.to_datetime(df["race_date"])
    df = df.sort_values(["race_date", "race_id", "horse_number"])
    df["distance_bucket"] = (df["distance_m"] // 200).astype("Int64")
    recent = df.loc[df["finish_position"].notna()].groupby("horse_id", observed=True).tail(5)

    payload = {
        "meta": {
            "version": "history-v2",
            "dateFrom": str(df["race_date"].min().date()),
            "dateTo": str(df["race_date"].max().date()),
            "races": int(df["race_id"].nunique()),
            "runners": int(len(df)),
            "horses": int(df["horse_id"].nunique()),
            "leakagePolicy": "target race dateより前の確定結果のみ",
        },
        "horse": _rate_profile(df, ["horse_id"]),
        "horseRecent5": _rate_profile(recent, ["horse_id"]),
        "horseSurface": _rate_profile(df, ["horse_id", "surface"]),
        "horseDistance": _rate_profile(df, ["horse_id", "distance_bucket"]),
        "horseCourse": _rate_profile(df, ["horse_id", "racecourse"]),
        "jockey": _rate_profile(df, ["jockey_id"]),
        "trainer": _rate_profile(df, ["trainer_id"]),
        "course": _rate_profile(df, ["racecourse", "surface", "distance_bucket", "going"]),
        "gate": _rate_profile(df, ["racecourse", "surface", "distance_bucket", "gate"]),
    }
    if pairs:
        payload["horseJockey"] = _pair_counts(df)
    payload.update(extras or {})
    if pedigree:
        # Progeny records by sire; horses without a collected sire are left out.
        df["sire"] = df["horse_id"].map(lambda h: lineage_name((pedigree.get(_key(h)) or [""])[0]))
        sired = df.loc[df["sire"].ne("")]
        payload["sire"] = _rate_profile(sired, ["sire"])
        payload["sireSurfaceDistance"] = _rate_profile(sired, ["sire", "surface", "distance_bucket"])
        runners = int(df["finish_position"].notna().sum())
        payload["meta"]["pedigreeCoverage"] = round(int(sired["finish_position"].notna().sum()) / runners, 4) if runners else 0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(output_path, "wb", compresslevel=9) as handle:
        handle.write(raw)
    return {**payload["meta"], "compressedBytes": output_path.stat().st_size, "rawBytes": len(raw)}


def main() -> None:
    parser = argparse.ArgumentParser(description="REIN用の履歴傾向プロファイルを生成します")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.input, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
