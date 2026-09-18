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
