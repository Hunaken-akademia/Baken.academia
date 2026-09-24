from __future__ import annotations

import json
from pathlib import Path

import lightgbm as lgb
import pandas as pd

from rein_research import prepare
from rein_research_v3 import add_v3_features
from baken_academia.features import build_feature_frame


DIRECTION = {
    "札幌": "右", "函館": "右", "福島": "右", "新潟": "左", "東京": "左",
    "中山": "右", "中京": "左", "京都": "右", "阪神": "右", "小倉": "右",
}
ROLE_TARGETS = {"first": 1, "second": 2, "third": 3}


def add_smoothed_prior_rate(x: pd.DataFrame, keys: list[str], prefix: str) -> list[str]:
    """Add point-in-time top-three priors; the current result is always excluded."""
    group = x.groupby(["horse_id", *keys], observed=True, dropna=False)
    prior_starts = group.cumcount()
    prior_top3 = group["placed_for_prior"].cumsum() - x["placed_for_prior"]
    starts_name = f"horse_{prefix}_prior_starts"
    rate_name = f"horse_{prefix}_prior_top3_rate"
    x[starts_name] = prior_starts.astype(float)
    x[rate_name] = (prior_top3 + 4.5) / (prior_starts + 20)
    return [starts_name, rate_name]


def add_candidate_features(raw: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, list[str]], dict[str, object]]:
    x = raw.sort_values(["race_date", "race_id", "horse_number"]).copy()
    x["direction"] = x["racecourse"].map(DIRECTION)
    x["wet"] = x["going"].isin(["重", "不良"]).astype(int)
    x["placed_for_prior"] = pd.to_numeric(x["finish_position"], errors="coerce").between(1, 3).astype(float)

    candidates: dict[str, list[str]] = {}
    candidates["direction_suitability"] = add_smoothed_prior_rate(x, ["direction"], "direction")
    candidates["wet_suitability"] = add_smoothed_prior_rate(x, ["wet"], "wet")
    candidates["exact_going_suitability"] = add_smoothed_prior_rate(x, ["going"], "going")

    closing = pd.to_numeric(x["avg_1f"], errors="coerce").where(x["surface"].isin(["芝", "ダート"]))
    race_min = closing.groupby(x["race_id"], observed=True).transform("min")
    fastest = (closing - race_min).abs().le(1e-9).astype(float)
    prior_fastest = fastest.groupby(x["horse_id"], observed=True).shift(1)
    x["recent3_fastest_closing_count"] = (
        prior_fastest.groupby(x["horse_id"], observed=True)
        .rolling(3, min_periods=1).sum().reset_index(level=0, drop=True)
    )
    candidates["recent3_fastest_closing"] = ["recent3_fastest_closing_count"]

    layout_rows = 0
    if "course_detail" in x.columns:
        detail = x["course_detail"].astype("string")
        x["course_layout"] = detail.str.extract(r"(?:^|[・ ])(内|外)(?:[・ ]|$)", expand=False)
        layout_rows = int(x["course_layout"].notna().sum())
        if layout_rows:
            candidates["inner_outer_suitability"] = add_smoothed_prior_rate(x, ["course_layout"], "layout")

    availability = {
        "raw_columns": sorted(map(str, raw.columns)),
        "course_detail": "course_detail" in raw.columns,
        "inner_outer_observed_rows": layout_rows,
        "straight_shape": any(c in raw.columns for c in ("straight_shape", "straight_length_m", "turn_configuration")),
        "blinkers": any(c in raw.columns for c in ("blinkers", "blinker", "equipment")),
        "breeder": any(c in raw.columns for c in ("breeder", "breeder_name")),
        "owner": any(c in raw.columns for c in ("owner", "owner_name")),
    }
    return x, candidates, availability


def venue_summary(raw: pd.DataFrame) -> list[dict[str, object]]:
    z = raw.loc[raw["surface"].isin(["芝", "ダート"])].copy()
    z["finish_position"] = pd.to_numeric(z["finish_position"], errors="coerce")
    z["gate"] = pd.to_numeric(z["gate"], errors="coerce")
    z["popularity"] = pd.to_numeric(z["popularity"], errors="coerce")
    rows = []
    for course, g in z.groupby("racecourse", observed=True):
        winners = g.loc[g["finish_position"].eq(1)]
        top3 = g.loc[g["finish_position"].between(1, 3)]
        rows.append({
            "racecourse": course, "direction": DIRECTION.get(course), "races": int(g["race_id"].nunique()),
            "winner_avg_gate": float(winners["gate"].mean()), "top3_avg_gate": float(top3["gate"].mean()),
            "favorite_win_rate": float(g.loc[g["popularity"].eq(1), "finish_position"].eq(1).mean()),
            "favorite_top3_rate": float(g.loc[g["popularity"].eq(1), "finish_position"].between(1, 3).mean()),
            "wet_race_share": float(g.groupby("race_id", observed=True)["going"].first().isin(["重", "不良"]).mean()),
        })
    return rows


def role_rank_metrics(rows: pd.DataFrame, prediction, position: int) -> dict[str, object]:
    """Measure one exact finishing-position model without involving ticket ROI."""
    z = rows[["race_id", "finish_position"]].copy()
    z["score"] = prediction
    z["role_rank"] = z.groupby("race_id", observed=True)["score"].rank(method="first", ascending=False)
    finish = pd.to_numeric(z["finish_position"], errors="coerce")
    actual = z.loc[finish.eq(position)]
    per_rank = []
    cumulative = []
    for rank in range(1, 6):
        selected = z.loc[z["role_rank"].eq(rank)]
        selected_finish = pd.to_numeric(selected["finish_position"], errors="coerce")
        per_rank.append({
            "rank": rank,
            "horses": int(len(selected)),
            "actual_position_rate": float(selected_finish.eq(position).mean()) if len(selected) else 0.0,
        })
        cumulative.append({
            "top_n": rank,
            "actual_horses": int(len(actual)),
            "actual_horse_in_top_n_rate": float(actual["role_rank"].le(rank).mean()) if len(actual) else 0.0,
        })
    return {
        "races": int(z["race_id"].nunique()),
        "target_finish_position": position,
        "per_rank": per_rank,
        "cumulative": cumulative,
        "rank1_exact_rate": per_rank[0]["actual_position_rate"],
        "actual_in_top3_rate": cumulative[2]["actual_horse_in_top_n_rate"],
        "actual_in_top5_rate": cumulative[4]["actual_horse_in_top_n_rate"],
    }


def objective(value: dict[str, object]) -> float:
    return float(value["rank1_exact_rate"] + 0.5 * value["actual_in_top3_rate"]
                 + 0.25 * value["actual_in_top5_rate"])


def metric_delta(candidate: dict[str, object], baseline: dict[str, object]) -> dict[str, object]:
    summary = ("rank1_exact_rate", "actual_in_top3_rate", "actual_in_top5_rate")
    result: dict[str, object] = {
        name + "_pp": 100 * (float(candidate[name]) - float(baseline[name])) for name in summary
    }
    result["per_rank_actual_position_rate_pp"] = [
        100 * (float(c["actual_position_rate"]) - float(b["actual_position_rate"]))
        for c, b in zip(candidate["per_rank"], baseline["per_rank"])
    ]
    result["cumulative_top_n_rate_pp"] = [
        100 * (float(c["actual_horse_in_top_n_rate"]) - float(b["actual_horse_in_top_n_rate"]))
        for c, b in zip(candidate["cumulative"], baseline["cumulative"])
    ]
    result["objective_pp"] = 100 * (objective(candidate) - objective(baseline))
    return result


def train_compare(raw: pd.DataFrame) -> tuple[dict[str, object], dict[str, object]]:
    x = prepare(raw)
    x, candidate_groups, availability = add_candidate_features(x)
    x, advanced = add_v3_features(x)
    base, _, _ = build_feature_frame(x)

    candidate_columns = {c for columns in candidate_groups.values() for c in columns}
    inherited = [c for c in x if (c.startswith(("prior_", "recent3_")) or "_recent90_" in c)
                 and c not in candidate_columns] + ["expected_front_count", "relative_early"]
    standard = list(dict.fromkeys(inherited + advanced))
    baseline = pd.concat([base, x[standard]], axis=1)

    variants: dict[str, dict[str, object]] = {
        "current_rein": {"frame": baseline, "kind": "baseline", "feature_columns": []}
    }
    for name, columns in candidate_groups.items():
        variants["plus_" + name] = {
            "frame": pd.concat([baseline, x[columns]], axis=1),
            "kind": "candidate_addition", "feature_columns": columns,
        }

    ablation_groups = {
        "surface_suitability": ["surface", "same_surface_as_last", *[c for c in baseline if c.startswith("horse_surface_")]],
        "distance_suitability": [
            "distance_m", "distance_change_m", *[c for c in baseline if c.startswith("horse_distance_")],
            *[c for c in ("prior_distance_m", "distance_abs_change", "stretching_out", "shortening",
                          "recent3_distance_m", "distance_vs_recent3") if c in baseline],
        ],
        "course_suitability": ["racecourse", "same_course_as_last", *[c for c in baseline if c.startswith("horse_course_")]],
        "current_going": ["going"],
    }
    for name, columns in ablation_groups.items():
        existing = list(dict.fromkeys(c for c in columns if c in baseline.columns))
        variants["without_" + name] = {
            "frame": baseline.drop(columns=existing), "kind": "existing_feature_ablation",
            "feature_columns": existing,
        }

    flat = x["surface"].isin(["芝", "ダート"])
    periods = {
        "tune_2025": x["race_date"].between("2025-01-01", "2025-12-31") & flat,
        "tune_2025_h1": x["race_date"].between("2025-01-01", "2025-06-30") & flat,
        "tune_2025_h2": x["race_date"].between("2025-07-01", "2025-12-31") & flat,
        "audit_2026": x["race_date"].ge("2026-01-01") & flat,
    }
    train = x["race_date"].lt("2025-01-01") & flat
    report: dict[str, object] = {
        "scope": {"training": "through 2024-12-31", "selection_and_stability": "2025 only",
                  "final_audit": "2026, never used to tune model or thresholds", "flat_races_only": True},
        "targets": {}, "candidate_decisions": {}, "existing_feature_evidence": {},
    }

    for target, position in ROLE_TARGETS.items():
        y = pd.to_numeric(x["finish_position"], errors="coerce").eq(position)
        target_report: dict[str, object] = {}
        for name, spec in variants.items():
            frame = spec["frame"]
            model = lgb.LGBMClassifier(
                n_estimators=650, learning_rate=0.03, num_leaves=15, min_child_samples=250,
                feature_fraction=0.8, bagging_fraction=0.9, bagging_freq=1, reg_lambda=8,
                n_jobs=4, verbosity=-1, random_state=1200 + position,
            )
            model.fit(frame.loc[train], y.loc[train])
            prediction = model.predict_proba(frame)[:, 1]
            target_report[name] = {
                "kind": spec["kind"], "feature_columns": spec["feature_columns"],
                "periods": {period: role_rank_metrics(x.loc[mask], prediction[mask], position)
                            for period, mask in periods.items()},
            }

        baseline_periods = target_report["current_rein"]["periods"]
        for name, result in target_report.items():
            if name == "current_rein":
                continue
            result["delta_vs_current_rein"] = {}
            for period in periods:
                if result["kind"] == "candidate_addition":
                    result["delta_vs_current_rein"][period] = metric_delta(result["periods"][period], baseline_periods[period])
                else:
                    result["delta_vs_current_rein"][period] = metric_delta(baseline_periods[period], result["periods"][period])
        report["targets"][target] = target_report

    for group in candidate_groups:
        name = "plus_" + group
        by_target = {}
        for target in ROLE_TARGETS:
            deltas = report["targets"][target][name]["delta_vs_current_rein"]
            tune_stable = all(
                deltas[p]["objective_pp"] > 0 and deltas[p]["rank1_exact_rate_pp"] >= 0
                for p in ("tune_2025", "tune_2025_h1", "tune_2025_h2")
            )
            audit_confirmed = (
                deltas["audit_2026"]["objective_pp"] > 0
                and deltas["audit_2026"]["rank1_exact_rate_pp"] >= 0
            )
            by_target[target] = {"tune_2025_stable": tune_stable, "audit_2026_confirmed": audit_confirmed,
                                 "adoption_candidate": tune_stable and audit_confirmed}
        report["candidate_decisions"][group] = {
            "by_target": by_target,
            "adoption_candidate": all(value["adoption_candidate"] for value in by_target.values()),
            "production_applied": False,
        }

    for group in ablation_groups:
        name = "without_" + group
        report["existing_feature_evidence"][group] = {
            target: {
                "tune_2025_objective_pp": report["targets"][target][name]["delta_vs_current_rein"]["tune_2025"]["objective_pp"],
                "audit_2026_objective_pp": report["targets"][target][name]["delta_vs_current_rein"]["audit_2026"]["objective_pp"],
            } for target in ROLE_TARGETS
        }
    return report, availability


def main() -> None:
    raw = pd.read_parquet("data/raw/jra/races-2019-2026.parquet")
    raw["race_date"] = pd.to_datetime(raw["race_date"])
    comparison, availability = train_compare(raw)
    out = Path("reports/jra-venue-features-v2")
    out.mkdir(parents=True, exist_ok=True)
    report = {
        "venue_summary": venue_summary(raw), "one_at_a_time_feature_test": comparison,
        "data_availability": availability,
        "unavailable_feature_requirements": {
            "straight_shape": "official course geometry keyed by venue, surface, layout and distance",
            "first_time_blinkers": "race-day equipment flag plus each horse's prior equipment history",
            "shadai_group_breeder": "breeder name or ID with a point-in-time Shadai Group master",
        },
        "safety": {"production_rein_modified": False, "wake_modified": False, "production_tables_modified": False},
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    pd.DataFrame(report["venue_summary"]).to_csv(out / "venue-summary.csv", index=False)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
