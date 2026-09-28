"""Full-data NAR correction revalidation.

The frozen production release is compared with fresh absolute/relative/hybrid
candidates and the popularity baseline. Candidate selection uses 2025 only;
2026 and dates after the frozen release coverage are audit-only.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

try:
    from nar_live_model import inputs_by_mode, normalize_courses, prior_features
except ModuleNotFoundError:
    from scripts.nar_live_model import inputs_by_mode, normalize_courses, prior_features


MIN_SEGMENT_RACES = 100
POST_RELEASE_MIN_RACES = 500
FIELD_LABELS = ["5-7", "8-10", "11-13", "14+"]


def _rate(rows: pd.DataFrame, minimum_popularity: int) -> dict[str, int | float | None]:
    selected = rows if minimum_popularity == 1 else rows.loc[rows["popularity"].ge(minimum_popularity)]
    races = int(len(selected))
    hits = int(selected["rank"].le(5).sum())
    return {"races": races, "hits": hits, "rate": round(hits / races, 6) if races else None}


def _ranked_actual(frame: pd.DataFrame, scores: np.ndarray, target: int) -> pd.DataFrame:
    columns = ["race_id", "finish_position", "popularity", "racecourse", "surface", "distance_bucket"]
    check = frame[columns].copy()
    check["score"] = scores
    check["rank"] = check.groupby("race_id", observed=True)["score"].rank(method="first", ascending=False)
    actual = check.loc[check["finish_position"].eq(target)].copy()
    actual = actual.loc[actual.groupby("race_id", observed=True)["race_id"].transform("size").eq(1)]
    field_sizes = frame.groupby("race_id", observed=True).size()
    actual["field_size"] = actual["race_id"].map(field_sizes)
    actual["field_size_bucket"] = pd.cut(
        actual["field_size"],
        bins=[4, 7, 10, 13, np.inf],
        labels=FIELD_LABELS,
        include_lowest=True,
    ).astype("string")
    return actual


def _segment_rows(actual: pd.DataFrame, column: str) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    for value, group in actual.groupby(column, observed=True, dropna=False):
        if len(group) < MIN_SEGMENT_RACES:
            continue
        output.append({
            "segment": None if pd.isna(value) else (value.item() if hasattr(value, "item") else value),
            "top5": _rate(group, 1),
            "popularity4plus": _rate(group, 4),
            "popularity10plus": _rate(group, 10),
        })
    return output


def evaluate(frame: pd.DataFrame, scores: np.ndarray, target: int, include_segments: bool = True) -> dict[str, object]:
    actual = _ranked_actual(frame, scores, target)
    result: dict[str, object] = {
        "top5": _rate(actual, 1),
        "popularity4plus": _rate(actual, 4),
        "popularity10plus": _rate(actual, 10),
    }
    if include_segments:
        result["segments"] = {
            "racecourse": _segment_rows(actual, "racecourse"),
            "distance_bucket": _segment_rows(actual, "distance_bucket"),
            "surface": _segment_rows(actual, "surface"),
            "field_size": _segment_rows(actual, "field_size_bucket"),
        }
    return result


def _score_frozen(x_modes: dict[str, np.ndarray], role: dict[str, object]) -> np.ndarray:
    mode = str(role["mode"])
    features = x_modes[mode]
    coef = np.asarray(role["coef"], dtype=float)
    if features.shape[1] != len(coef):
        raise ValueError(f"Frozen release feature width mismatch: {features.shape[1]} != {len(coef)}")
    return float(role["intercept"]) + features @ coef


def _metric(report: dict[str, object], key: str) -> float:
    value = report[key]["rate"]
    return float(value) if value is not None else 0.0


def _segment_consistency(candidate: dict[str, object], current: dict[str, object]) -> dict[str, object]:
    compared = 0
    non_regressions = 0
    details = []
    for group_name in ("racecourse", "distance_bucket", "surface", "field_size"):
        current_rows = {str(row["segment"]): row for row in current.get("segments", {}).get(group_name, [])}
        for row in candidate.get("segments", {}).get(group_name, []):
            peer = current_rows.get(str(row["segment"]))
            if not peer:
                continue
            cand_rate = row["top5"]["rate"]
            curr_rate = peer["top5"]["rate"]
            if cand_rate is None or curr_rate is None:
                continue
            compared += 1
            ok = float(cand_rate) >= float(curr_rate) - 0.002
            non_regressions += int(ok)
            details.append({
                "group": group_name,
                "segment": row["segment"],
                "races": row["top5"]["races"],
                "candidate": cand_rate,
                "current": curr_rate,
                "delta": round(float(cand_rate) - float(curr_rate), 6),
                "non_regression": ok,
            })
    return {
        "compared": compared,
        "non_regressions": non_regressions,
        "rate": round(non_regressions / compared, 6) if compared else None,
        "details": details,
    }


def build_report(data: pd.DataFrame, frozen: dict[str, object]) -> dict[str, object]:
    data = normalize_courses(data)
    data["race_date"] = pd.to_datetime(data["race_date"], errors="coerce")
    data = data.loc[data["finish_position"].notna()].sort_values(
        ["race_date", "race_id", "horse_number"]
    ).drop_duplicates(["race_id", "horse_id"]).reset_index(drop=True)
    for column in ("finish_position", "popularity", "distance_m"):
        data[column] = pd.to_numeric(data[column], errors="coerce")
    data["distance_bucket"] = (data["distance_m"] // 200 * 200).astype("Int64")

    base = prior_features(data)
    x_modes = inputs_by_mode(base, data["race_id"])
    train = data["race_date"].lt("2025-01-01").to_numpy()
    selection = data["race_date"].between("2025-01-01", "2025-12-31").to_numpy()
    audit = data["race_date"].ge("2026-01-01").to_numpy()
    frozen_date_to = pd.Timestamp(frozen["coverage"]["date_to"])
    post_release = data["race_date"].gt(frozen_date_to).to_numpy()

    report: dict[str, object] = {
        "status": "completed",
        "policy": {
            "training": "2019-2024",
            "selection": "2025 only",
            "audit": "2026 only",
            "frozen_release_out_of_sample": f"after {frozen_date_to.date()}",
            "top5": "score rank <= 5",
            "segment_min_races": MIN_SEGMENT_RACES,
            "no_future_leakage": True,
        },
        "coverage": {
            "races": int(data["race_id"].nunique()),
            "runners": int(len(data)),
            "date_from": str(data["race_date"].min().date()),
            "date_to": str(data["race_date"].max().date()),
            "selection_races": int(data.loc[selection, "race_id"].nunique()),
            "audit_races": int(data.loc[audit, "race_id"].nunique()),
            "post_release_races": int(data.loc[post_release, "race_id"].nunique()),
        },
        "frozen_release": {
            "version": frozen["live_model"]["version"],
            "profileSha": frozen["profileSha"],
            "coverage": frozen["coverage"],
        },
        "roles": {},
    }

    role_gates = []
    overall_deltas = []
    longshot_deltas = []
    segment_rates = []

    for target in (1, 2, 3):
        candidates: dict[str, dict[str, object]] = {}
        fitted_scores: dict[str, np.ndarray] = {}
        for mode, features in x_modes.items():
            scaler = StandardScaler().fit(features[train])
            model = LogisticRegression(C=0.1, max_iter=250).fit(
                scaler.transform(features[train]),
                data["finish_position"].eq(target).to_numpy()[train],
            )
            scores = model.decision_function(scaler.transform(features))
            fitted_scores[mode] = scores
            candidates[mode] = {
                "selection2025": evaluate(data.loc[selection], scores[selection], target, include_segments=False),
                "audit2026": evaluate(data.loc[audit], scores[audit], target),
                "post_release_window": evaluate(data.loc[post_release], scores[post_release], target),
            }

        selected_mode = max(
            fitted_scores,
            key=lambda mode: (
                _metric(candidates[mode]["selection2025"], "top5"),
                {"absolute": 2, "relative": 1, "hybrid": 0}[mode],
            ),
        )
        current_scores = _score_frozen(x_modes, frozen["live_model"]["roles"][str(target)])
        current_post = evaluate(data.loc[post_release], current_scores[post_release], target)
        market_scores = -data["popularity"].fillna(999).to_numpy(dtype=float)
        market_audit = evaluate(data.loc[audit], market_scores[audit], target)
        market_post = evaluate(data.loc[post_release], market_scores[post_release], target)

        selected_post = candidates[selected_mode]["post_release_window"]
        consistency = _segment_consistency(selected_post, current_post)
        overall_delta = _metric(selected_post, "top5") - _metric(current_post, "top5")
        longshot_delta = _metric(selected_post, "popularity4plus") - _metric(current_post, "popularity4plus")
        enough = selected_post["top5"]["races"] >= POST_RELEASE_MIN_RACES
        role_pass = (
            enough
            and overall_delta >= 0
            and longshot_delta >= -0.002
            and (consistency["rate"] is None or consistency["rate"] >= 0.60)
        )
        overall_deltas.append(overall_delta)
        longshot_deltas.append(longshot_delta)
        if consistency["rate"] is not None:
            segment_rates.append(float(consistency["rate"]))
        role_gates.append(role_pass)

        report["roles"][str(target)] = {
            "selected_mode": selected_mode,
            "candidates": candidates,
            "frozen_current_post_release": current_post,
            "market_baseline2026": market_audit,
            "market_baseline_post_release": market_post,
            "selected_vs_current": {
                "overall_delta": round(overall_delta, 6),
                "popularity4plus_delta": round(longshot_delta, 6),
                "segment_consistency": consistency,
                "enough_post_release_races": enough,
                "role_pass": role_pass,
            },
        }

    mean_overall = float(np.mean(overall_deltas))
    mean_longshot = float(np.mean(longshot_deltas))
    mean_segment = float(np.mean(segment_rates)) if segment_rates else 0.0
    adopt = (
        all(role_gates)
        and mean_overall >= 0.003
        and mean_longshot >= 0
        and mean_segment >= 0.60
    )
    report["adoption_gate"] = {
        "decision": "adopt" if adopt else "hold",
        "requirements": {
            "all_roles_non_regression": True,
            "mean_overall_improvement_min": 0.003,
            "mean_popularity4plus_delta_min": 0.0,
            "mean_segment_non_regression_min": 0.60,
            "post_release_min_races_per_role": POST_RELEASE_MIN_RACES,
        },
        "observed": {
            "all_roles_pass": all(role_gates),
            "mean_overall_delta": round(mean_overall, 6),
            "mean_popularity4plus_delta": round(mean_longshot, 6),
            "mean_segment_non_regression": round(mean_segment, 6),
        },
        "reason": (
            "2025選択と2026・公開後相当期間の双方で改善が再現し、保守的な採用条件を満たした。"
            if adopt else
            "改善の再現性または公開後相当期間の母数が採用条件に届かないため、現行版を保持する。"
        ),
    }
    return report


def write_summary(report: dict[str, object], path: Path) -> None:
    coverage = report["coverage"]
    gate = report["adoption_gate"]
    lines = [
        "# NAR全量補正再検証",
        "",
        f"- 対象: {coverage['date_from']}〜{coverage['date_to']}",
        f"- 全体: {coverage['races']:,}レース・{coverage['runners']:,}走",
        f"- 2025選択: {coverage['selection_races']:,}レース",
        f"- 2026監査: {coverage['audit_races']:,}レース",
        f"- 現行版の学習範囲後: {coverage['post_release_races']:,}レース",
        "",
        "| 着順 | 2025選択方式 | 現行版との差（全体） | 4番人気以下差 | 判定 |",
        "|---|---|---:|---:|---|",
    ]
    for target in ("1", "2", "3"):
        role = report["roles"][target]
        delta = role["selected_vs_current"]
        lines.append(
            f"| {target}着 | {role['selected_mode']} | {delta['overall_delta']:+.2%} | "
            f"{delta['popularity4plus_delta']:+.2%} | {'通過' if delta['role_pass'] else '保留'} |"
        )
    lines.extend([
        "",
        f"## 採否: {'採用候補' if gate['decision'] == 'adopt' else '現行版を保持'}",
        "",
        f"- 全体差平均: {gate['observed']['mean_overall_delta']:+.2%}",
        f"- 4番人気以下差平均: {gate['observed']['mean_popularity4plus_delta']:+.2%}",
        f"- セグメント非悪化率平均: {gate['observed']['mean_segment_non_regression']:.2%}",
        f"- 理由: {gate['reason']}",
        "",
        "※ このレポート単体では本番モデルを切り替えない。採用条件通過後も既存テスト、モデル版固定、復旧経路を確認してから反映する。",
    ])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-file", type=Path, required=True)
    parser.add_argument("--frozen-release", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    data = pd.read_parquet(args.input_file)
    frozen = json.loads(args.frozen_release.read_text(encoding="utf-8"))
    report = build_report(data, frozen)
    (args.output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    write_summary(report, args.output_dir / "summary.md")
    print(json.dumps(report["adoption_gate"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
