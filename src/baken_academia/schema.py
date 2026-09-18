from __future__ import annotations

import pandas as pd


REQUIRED_COLUMNS = {
    "race_id",
    "race_date",
    "horse_id",
    "finish_position",
    "racecourse",
    "surface",
    "distance_m",
    "horse_number",
    "gate",
    "age",
    "sex",
    "weight_carried",
}

# Columns that reveal information unavailable at prediction time.
FORBIDDEN_FEATURE_COLUMNS = {
    "finish_position",
    "finish_time",
    "time_seconds",
    "margin",
    "payout",
    "win_payout",
    "place_payout",
    "closing_rank",
    "final_odds",
}


def validate_input(df: pd.DataFrame) -> pd.DataFrame:
    missing = sorted(REQUIRED_COLUMNS - set(df.columns))
    if missing:
        raise ValueError(f"必須列が不足しています: {', '.join(missing)}")

    cleaned = df.copy()
    cleaned["race_date"] = pd.to_datetime(cleaned["race_date"], errors="raise")
    cleaned["finish_position"] = pd.to_numeric(
        cleaned["finish_position"], errors="coerce"
    )

    if cleaned[["race_id", "horse_id"]].duplicated().any():
        raise ValueError("race_id と horse_id の組み合わせが重複しています")
    if cleaned["race_id"].isna().any() or cleaned["horse_id"].isna().any():
        raise ValueError("race_id / horse_id に欠損があります")

    winners = cleaned.assign(
        is_win=(cleaned["finish_position"] == 1).astype(int)
    ).groupby("race_id", observed=True)["is_win"].sum()
    invalid = winners[winners != 1]
    if not invalid.empty:
        raise ValueError(
            f"1着馬が1頭でないレースがあります（先頭例: {invalid.index[0]}）"
        )

    return cleaned.sort_values(["race_date", "race_id", "horse_number"]).reset_index(
        drop=True
    )
