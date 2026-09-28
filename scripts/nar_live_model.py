"""Small, portable NAR-only ranker. All history features end before the race day.

No current odds/popularity/outcome is used as an input. Outputs are ranking shares,
not calibrated probabilities. Model selection uses 2025; 2026 stays an audit set.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

COURSES = {3: "帯広", 10: "盛岡", 11: "水沢", 18: "浦和", 19: "船橋", 20: "大井", 21: "川崎", 22: "金沢", 23: "笠松", 24: "名古屋", 27: "園田", 28: "姫路", 31: "高知", 32: "佐賀", 36: "門別"}
GROUPS = {
    "horse": ["horse_id"], "horseSurface": ["horse_id", "surface"],
    "horseDistance": ["horse_id", "distance_bucket"], "horseCourse": ["horse_id", "racecourse"],
    "jockey": ["jockey_id"], "trainer": ["trainer_id"],
    "gate": ["racecourse", "surface", "distance_bucket", "gate"],
}
FEATURES = [f"{name}.{kind}" for name in GROUPS for kind in ("n", "w", "t", "f")]


def normalize_courses(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    codes = pd.to_numeric(out.get("baba_code"), errors="coerce")
    out["racecourse"] = codes.map(COURSES).fillna(out["racecourse"])
    out.loc[codes.eq(3), "surface"] = "ばんえい"
    return out


def prior_features(frame: pd.DataFrame) -> np.ndarray:
    # Aggregate a whole date first, then subtract the current date: no same-day
    # trainer/jockey results leak into a later race that morning.
    work = frame.copy()
    work["distance_bucket"] = (work["distance_m"] // 200).astype("Int64")
    work["_w"] = work.finish_position.eq(1).astype(int)
    work["_t"] = work.finish_position.between(1, 3).astype(int)
    work["_n"] = work.finish_position.notna().astype(int)
    work["_f"] = work.finish_position.fillna(0)
    output = []
    for keys in GROUPS.values():
        daily = work.groupby(keys + ["race_date"], dropna=False, observed=True)[["_n", "_w", "_t", "_f"]].sum().reset_index()
        daily = daily.sort_values("race_date")
        cumulative = daily.groupby(keys, dropna=False, observed=True)[["_n", "_w", "_t", "_f"]].cumsum()
        daily[["_n", "_w", "_t", "_f"]] = cumulative - daily[["_n", "_w", "_t", "_f"]]
        joined = work[keys + ["race_date"]].merge(daily, on=keys + ["race_date"], how="left", sort=False)
        n = joined._n.to_numpy(dtype=float)
        output.extend([np.minimum(np.log1p(n) / np.log(101), 2), (joined._w.to_numpy() + 1.5) / (n + 20), (joined._t.to_numpy() + 4.5) / (n + 20), np.where(n > 0, joined._f.to_numpy() / np.maximum(n, 1) / 18, 0.5)])
    return np.nan_to_num(np.column_stack(output), nan=0)


def inputs_by_mode(base: np.ndarray, races: pd.Series) -> dict[str, np.ndarray]:
    df = pd.DataFrame(base)
    means = df.groupby(races.reset_index(drop=True), sort=False).transform("mean").to_numpy()
    stds = df.groupby(races.reset_index(drop=True), sort=False).transform("std").fillna(0).to_numpy()
    relative = (base - means) / np.maximum(stds, 0.01)
    return {"absolute": base, "relative": relative, "hybrid": np.column_stack([base, relative])}


def audit(frame: pd.DataFrame, scores: np.ndarray, target: int) -> dict:
    check = frame[["race_id", "finish_position", "popularity"]].copy()
    check["score"] = scores
    check["rank"] = check.groupby("race_id").score.rank(method="first", ascending=False)
    actual = check.loc[check.finish_position.eq(target)]
    # Tied target finishes don't have an unambiguous exact-place denominator.
    actual = actual.loc[actual.groupby("race_id").race_id.transform("size").eq(1)]
    return {str(p): {"races": int(len(g)), "hits": int(g["rank"].le(5).sum()), "rate": round(float(g["rank"].le(5).mean()), 6) if len(g) else None}
            for p in (1, 4, 10) for g in [actual if p == 1 else actual.loc[actual.popularity.ge(p)]]}


def fit_live_model(frame: pd.DataFrame) -> dict:
    data = frame.loc[frame.finish_position.notna()].sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    x_modes = inputs_by_mode(prior_features(data), data.race_id)
    train = data.race_date.lt("2025-01-01").to_numpy()
    select = data.race_date.ge("2025-01-01").to_numpy() & data.race_date.lt("2026-01-01").to_numpy()
    test = data.race_date.ge("2026-01-01").to_numpy()
    if min(train.sum(), select.sum(), test.sum()) < 1000:
        return {"status": "insufficient", "reason": "時系列分割の母数不足"}
    roles, comparison = {}, {}
    for target in (1, 2, 3):
        y = data.finish_position.eq(target).to_numpy()
        candidates = []
        comparison[str(target)] = {}
        for mode, features in x_modes.items():
            scaler = StandardScaler().fit(features[train])
            model = LogisticRegression(C=0.1, max_iter=250).fit(scaler.transform(features[train]), y[train])
            validation = audit(data.loc[select], model.decision_function(scaler.transform(features[select])), target)
            heldout = audit(data.loc[test], model.decision_function(scaler.transform(features[test])), target)
            comparison[str(target)][mode] = {"selection2025": validation, "audit2026": heldout}
            candidates.append((validation["1"]["rate"] or 0, mode))
        # Resolve ties deterministically, preferring the lower dimensional model.
        mode = max(candidates, key=lambda pair: (pair[0], {"absolute": 2, "relative": 1, "hybrid": 0}[pair[1]]))[1]
        features = x_modes[mode]
        scaler = StandardScaler().fit(features)
        fitted = LogisticRegression(C=0.1, max_iter=250).fit(scaler.transform(features), y)
        coef = fitted.coef_[0] / scaler.scale_
        intercept = fitted.intercept_[0] - np.dot(coef, scaler.mean_)
        roles[str(target)] = {"mode": mode, "coef": np.round(coef, 9).tolist(), "intercept": round(float(intercept), 9)}
    return {
        "status": "provisional", "version": "nar-history-ranker-v1", "features": FEATURES,
        "roles": roles, "comparison": comparison,
        "marketBaseline2026": {str(t): audit(data.loc[test], -data.loc[test, "popularity"].fillna(999).to_numpy(), t) for t in (1, 2, 3)},
        "selectionPeriod": "2025", "auditPeriod": "2026 (取得済み範囲)",
        "probabilityKind": "ranking-share", "inputs": "発走日前の地方履歴のみ。当日オッズ・人気は不使用。",
        "note": "相対・絶対・ハイブリッドを2025年の適性Top5で選択。2026年は未使用監査。数値は未校正の評価シェアで、的中確率ではありません。",
    }
