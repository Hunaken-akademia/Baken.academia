from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from baken_academia.rein_history import build as build_history_profile


def _pct(v: float) -> float:
    return round(float(v), 6)


def _race_level_market(frame: pd.DataFrame) -> dict[str, float | int]:
    valid = frame.loc[frame["finish_position"].notna() & frame["popularity"].notna()].copy()
    races = valid.groupby("race_id", observed=True)
    total = valid["race_id"].nunique()
    if total == 0:
        return {"races": 0}

    top1 = valid.loc[valid["popularity"].eq(1)]
    top1_by_race = top1.groupby("race_id", observed=True)
    top3 = valid.loc[valid["popularity"].between(1, 3)]
    top3_by_race = top3.groupby("race_id", observed=True)

    winner_in_top3 = top3.groupby("race_id", observed=True)["finish_position"].apply(lambda s: bool((s == 1).any()))
    placed_count = top3.groupby("race_id", observed=True)["finish_position"].apply(lambda s: int(s.between(1, 3).sum()))

    return {
        "races": int(total),
        "pop1_win_rate": _pct(top1_by_race["finish_position"].apply(lambda s: bool((s == 1).any())).mean()),
        "pop1_top3_rate": _pct(top1_by_race["finish_position"].apply(lambda s: bool(s.between(1, 3).any())).mean()),
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
