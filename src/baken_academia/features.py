from __future__ import annotations

import pandas as pd

from .schema import FORBIDDEN_FEATURE_COLUMNS


DEFAULT_FEATURES = [
    "racecourse",
    "surface",
    "distance_m",
    "horse_number",
    "gate",
    "age",
    "sex",
    "weight_carried",
    "going",
    "race_class",
    "jockey_id",
    "trainer_id",
    "horse_weight",
    "horse_weight_change",
    "field_size",
    "horse_number_pct",
    "gate_pct",
    "weight_carried_vs_field",
    "horse_weight_vs_field",
    "horse_starts",
    "horse_win_rate",
    "horse_top3_rate",
    "horse_avg_finish",
    "jockey_starts",
    "jockey_win_rate",
    "jockey_top3_rate",
    "jockey_avg_finish",
    "trainer_starts",
    "trainer_win_rate",
    "trainer_top3_rate",
    "trainer_avg_finish",
    "horse_surface_starts",
    "horse_surface_win_rate",
    "horse_surface_top3_rate",
    "horse_surface_avg_finish",
    "horse_distance_starts",
    "horse_distance_win_rate",
    "horse_distance_top3_rate",
    "horse_distance_avg_finish",
    "horse_course_starts",
    "horse_course_win_rate",
    "horse_course_top3_rate",
    "horse_course_avg_finish",
    "days_since_last_start",
    "distance_change_m",
    "same_surface_as_last",
    "same_course_as_last",
    "horse_recent5_avg_finish",
    "horse_recent5_win_rate",
    "horse_recent5_top3_rate",
]

CATEGORICAL_FEATURES = {
    "racecourse",
    "surface",
    "sex",
    "going",
    "race_class",
    "jockey_id",
    "trainer_id",
}


def build_feature_frame(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, list[str]]:
    selected = [name for name in DEFAULT_FEATURES if name in df.columns]
    leaked = sorted(set(selected) & FORBIDDEN_FEATURE_COLUMNS)
    if leaked:
        raise ValueError(f"未来情報を特徴量に使用できません: {', '.join(leaked)}")

    features = df[selected].copy()
    categorical = [name for name in selected if name in CATEGORICAL_FEATURES]
    for name in categorical:
        features[name] = features[name].fillna("__missing__").astype("category")
    for name in set(selected) - set(categorical):
        features[name] = pd.to_numeric(features[name], errors="coerce")

    target = (df["finish_position"] == 1).astype(int)
    return features, target, categorical
