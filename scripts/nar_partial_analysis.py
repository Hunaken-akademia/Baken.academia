from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from baken_academia.rein_history import build as build_history_profile


def _pct(v: float) -> float:
    return round(float(v), 6)


def _market_data_quality(frame: pd.DataFrame) -> dict[str, float | int]:
    popularity = pd.to_numeric(frame.get("popularity"), errors="coerce")
    win_odds = pd.to_numeric(frame.get("win_odds"), errors="coerce")
    gate = pd.to_numeric(frame.get("gate"), errors="coerce")
    horse_number = pd.to_numeric(frame.get("horse_number"), errors="coerce")

    popularity_gate = popularity.notna() & gate.notna()
    odds_horse = win_odds.notna() & horse_number.notna()
    pop1_per_race = frame.assign(_popularity=popularity).groupby(
        "race_id", observed=True
    )["_popularity"].apply(lambda values: int(values.eq(1).sum()))

    return {
        "rows_with_popularity": int(popularity.notna().sum()),
        "rows_with_win_odds": int(win_odds.notna().sum()),
        "races_with_exactly_one_favorite": int(pop1_per_race.eq(1).sum()),
        "popularity_equals_gate_rate": _pct(
            popularity.loc[popularity_gate].eq(gate.loc[popularity_gate]).mean()
        ) if popularity_gate.any() else 0.0,
        "win_odds_equals_horse_number_rate": _pct(
            win_odds.loc[odds_horse].eq(horse_number.loc[odds_horse]).mean()
        ) if odds_horse.any() else 0.0,
    }


def _validate_market_columns(frame: pd.DataFrame) -> dict[str, float | int]:
    quality = _market_data_quality(frame)
    if (
        quality["rows_with_popularity"] >= 100
        and quality["popularity_equals_gate_rate"] >= 0.8
    ):
        raise ValueError(
            "NAR popularity is almost identical to gate; reject likely CSS-column "
            "misparse before publishing analysis"
        )
    if (
        quality["rows_with_win_odds"] >= 100
        and quality["win_odds_equals_horse_number_rate"] >= 0.8
    ):
        raise ValueError(
            "NAR win_odds is almost identical to horse_number; reject likely "
            "CSS-column misparse before publishing analysis"
        )
    return quality


def _race_level_market(frame: pd.DataFrame) -> dict[str, float | int]:
    valid = frame.loc[frame["finish_position"].notna() & frame["popularity"].notna()].copy()
    valid["finish_position"] = pd.to_numeric(valid["finish_position"], errors="coerce")
    valid["popularity"] = pd.to_numeric(valid["popularity"], errors="coerce")
    by_race = valid.groupby("race_id", observed=True)
    eligible = by_race.apply(
        lambda race: bool(
            race["finish_position"].eq(1).any()
            and race["popularity"].eq(1).sum() == 1
        ),
        include_groups=False,
    )
    race_ids = eligible.index[eligible]
    valid = valid.loc[valid["race_id"].isin(race_ids)]
    total = len(race_ids)
    if total == 0:
        return {"races": 0}

    top1 = valid.loc[valid["popularity"].eq(1)]
    top3 = valid.loc[valid["popularity"].between(1, 3)]
    top1_win = top1.groupby("race_id", observed=True)["finish_position"].apply(
        lambda values: bool(values.eq(1).any())
    ).reindex(race_ids, fill_value=False)
    top1_placed = top1.groupby("race_id", observed=True)["finish_position"].apply(
        lambda values: bool(values.between(1, 3).any())
    ).reindex(race_ids, fill_value=False)
    winner_in_top3 = top3.groupby("race_id", observed=True)["finish_position"].apply(
        lambda values: bool(values.eq(1).any())
    ).reindex(race_ids, fill_value=False)
    placed_count = top3.groupby("race_id", observed=True)["finish_position"].apply(
        lambda values: int(values.between(1, 3).sum())
    ).reindex(race_ids, fill_value=0)

    return {
        "races": int(total),
        "pop1_win_rate": _pct(top1_win.mean()),
        "pop1_top3_rate": _pct(top1_placed.mean()),
        "top3_contains_winner_rate": _pct(winner_in_top3.mean()),
        "top3_two_or_more_placed_rate": _pct((placed_count >= 2).mean()),
        "top3_all_placed_rate": _pct((placed_count >= 3).mean()),
    }


def _by_popularity(frame: pd.DataFrame) -> list[dict[str, object]]:
    valid = frame.loc[frame["finish_position"].notna() & frame["popularity"].notna()].copy()
    valid["win"] = valid["finish_position"].eq(1)
    valid["top3"] = valid["finish_position"].between(1, 3)
    rows = []
    for pop, g in valid.loc[valid["popularity"].between(1, 10)].groupby("popularity", observed=True):
        rows.append({
            "popularity": int(pop),
            "starts": int(len(g)),
            "win_rate": _pct(g["win"].mean()),
            "top3_rate": _pct(g["top3"].mean()),
            "avg_finish": round(float(g["finish_position"].mean()), 3),
            "avg_win_odds": round(float(g["win_odds"].dropna().mean()), 3) if g["win_odds"].notna().any() else None,
        })
    return rows


def _market_by_group(frame: pd.DataFrame, keys: list[str], min_races: int = 30) -> list[dict[str, object]]:
    valid = frame.loc[frame["finish_position"].notna() & frame["popularity"].notna()].copy()
    out = []
    grouped = valid.groupby(keys, observed=True, dropna=False)
    for idx, g in grouped:
        races = int(g["race_id"].nunique())
        if races < min_races:
            continue
        metrics = _race_level_market(g)
        values = idx if isinstance(idx, tuple) else (idx,)
        row = {}
        for k, v in zip(keys, values):
            if pd.isna(v):
                row[k] = None
            elif hasattr(v, "item"):
                row[k] = v.item()
            else:
                row[k] = v
        row.update(metrics)
        out.append(row)
    return out


def _payout_summary(frame: pd.DataFrame) -> list[dict[str, object]]:
    records = []
    seen = set()
    for _, row in frame.loc[frame["payouts"].notna(), ["race_id", "payouts"]].drop_duplicates("race_id").iterrows():
        try:
            payouts = json.loads(row["payouts"] or "[]")
        except Exception:
            continue
        for p in payouts:
            key = (row["race_id"], p.get("bet_type"), p.get("combination"))
            if key in seen:
                continue
            seen.add(key)
            records.append(p)
    if not records:
        return []
    pf = pd.DataFrame(records)
    if "payout_yen" not in pf:
        return []
    pf["payout_yen"] = pd.to_numeric(pf["payout_yen"], errors="coerce")
    out = []
    for bet, g in pf.dropna(subset=["payout_yen"]).groupby("bet_type", observed=True):
        out.append({
            "bet_type": str(bet),
            "samples": int(len(g)),
            "median_payout_yen": int(g["payout_yen"].median()),
            "mean_payout_yen": round(float(g["payout_yen"].mean()), 1),
            "p90_payout_yen": int(g["payout_yen"].quantile(0.9)),
        })
    return sorted(out, key=lambda x: x["bet_type"])


def build_report(input_dir: Path, output_dir: Path) -> dict[str, object]:
    parts = sorted(
        p for p in input_dir.rglob("nar-*.parquet")
        if not any(tag in p.name for tag in ("-odds-", "-payouts", "-manifest"))
    )
    if not parts:
        raise SystemExit("No NAR result parquet files were found")

    frames = [pd.read_parquet(p) for p in parts]
    df = pd.concat(frames, ignore_index=True)
    df["race_date"] = pd.to_datetime(df["race_date"], errors="coerce")
    df = df.sort_values(["race_date", "race_id", "horse_number"]).drop_duplicates(["race_id", "horse_id"])
    for column in ("finish_position", "popularity", "win_odds", "gate", "horse_number"):
        df[column] = pd.to_numeric(df[column], errors="coerce")
    data_quality = _validate_market_columns(df)
    df["distance_bucket"] = (pd.to_numeric(df["distance_m"], errors="coerce") // 200 * 200).astype("Int64")

    output_dir.mkdir(parents=True, exist_ok=True)
    combined = output_dir / "nar-partial-combined.parquet"
    df.to_parquet(combined, index=False)

    profile_path = output_dir / "nar-history-profile.json.gz"
    profile_meta = build_history_profile(combined, profile_path)

    report = {
        "status": "partial_rolling_analysis",
        "coverage": {
            "chunks": len(parts),
            "date_from": str(df["race_date"].min().date()),
            "date_to": str(df["race_date"].max().date()),
            "races": int(df["race_id"].nunique()),
            "runners": int(len(df)),
            "horses": int(df["horse_id"].nunique()),
            "racecourses": int(df["racecourse"].nunique()),
        },
        "data_quality": data_quality,
        "market_baseline": _race_level_market(df),
        "by_popularity": _by_popularity(df),
        "by_racecourse": _market_by_group(df, ["racecourse"], min_races=50),
        "by_racecourse_distance": _market_by_group(df, ["racecourse", "distance_bucket"], min_races=40),
        "payout_summary": _payout_summary(df),
        "history_profile": profile_meta,
        "notes": [
            "取得済みチャンクだけの暫定集計。NAR取得が進むたび再実行して母数を増やす。",
            "市場人気は予測モデルの比較基準として使用し、最終モデルの入力だけで結論を出さない。",
            "履歴プロファイルは馬・騎手・厩舎・コース・距離・枠の傾向をREIN側で再利用できる形式。",
        ],
    }

    (output_dir / "report.json").write_text(
        json.dumps(
            report,
            ensure_ascii=False,
            indent=2,
            default=lambda o: o.item() if hasattr(o, "item") else str(o),
        ),
        encoding="utf-8",
    )

    c = report["coverage"]
    m = report["market_baseline"]
    lines = [
        "# NAR 取得済みデータ並行分析",
        "",
        f"- 対象期間: {c['date_from']}〜{c['date_to']}",
        f"- 取得済みチャンク: {c['chunks']}",
        f"- レース数: {c['races']:,}",
        f"- 出走行数: {c['runners']:,}",
        f"- 競馬場数: {c['racecourses']}",
        f"- 人気列検証（人気＝枠の一致率）: {report['data_quality']['popularity_equals_gate_rate']:.2%}",
        f"- オッズ列検証（単勝＝馬番の一致率）: {report['data_quality']['win_odds_equals_horse_number_rate']:.2%}",
        "",
        "## 人気順ベースライン",
        "",
        f"- 1番人気1着率: {m.get('pop1_win_rate', 0):.2%}",
        f"- 1番人気3着内率: {m.get('pop1_top3_rate', 0):.2%}",
        f"- 人気上位3頭に勝ち馬が含まれる率: {m.get('top3_contains_winner_rate', 0):.2%}",
        f"- 人気上位3頭から2頭以上が3着内に入る率: {m.get('top3_two_or_more_placed_rate', 0):.2%}",
        f"- 人気上位3頭が全て3着内に入る率: {m.get('top3_all_placed_rate', 0):.2%}",
        "",
        "## 次段階",
        "",
        "- 1〜3着適性モデルをNAR専用で検証",
        "- 競馬場×距離×馬場×枠×騎手×厩舎の寄与を比較",
        "- 単複・馬連・ワイド・馬単・三連複・三連単の買い目点数と回収率を検証",
        "- JRAモデルとの共通部分とNAR専用補正を分離",
    ]
    (output_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    report = build_report(args.input_dir, args.output_dir)
    print(json.dumps(report["coverage"], ensure_ascii=False, indent=2))
    print(json.dumps(report["market_baseline"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
