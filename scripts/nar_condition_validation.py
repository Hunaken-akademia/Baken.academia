"""NAR conditional weights and reference signals, selected in 2025, audited in 2026.

This is an observational, retrospective audit, NOT a prospective profitability
claim. The 2026 period has been inspected for earlier models. Raw runner data and
per-runner predictions never leave the private analysis job.
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
    from nar_live_model import prior_features, inputs_by_mode, audit
except ModuleNotFoundError:
    from scripts.nar_live_model import prior_features, inputs_by_mode, audit


def distance_band(distance):
    return np.where(distance < 1400, "short", np.where(distance <= 1800, "mile", "long"))


def condition_keys(frame, kind):
    course = frame.racecourse.astype(str) + "|" + frame.surface.fillna("不明").astype(str)
    if kind == "courseDistance":
        return course + "|" + distance_band(frame.distance_m)
    if kind == "courseGoing":
        return course + "|" + frame.going.fillna("不明").astype(str)
    return course


def fit(features, target):
    scaler = StandardScaler().fit(features)
    model = LogisticRegression(C=.1, max_iter=200, tol=1e-5).fit(scaler.transform(features), target)
    coef = model.coef_[0] / scaler.scale_
    return {"coef": coef, "intercept": float(model.intercept_[0] - coef @ scaler.mean_)}


def predict(model, features):
    return features @ model["coef"] + model["intercept"]


def serial(model):
    return {"coef": np.round(model["coef"], 9).tolist(), "intercept": round(model["intercept"], 9)}


def local_models(data, features, target, mask, kind, global_model):
    keys = condition_keys(data, kind)
    result = {}
    for key, indices in data.loc[mask].groupby(keys[mask], sort=True).groups.items():
        indices = np.asarray(indices)
        # Avoid fitting tiny cells; unseen/small cells always use the global model.
        if len(indices) < 3000 or data.loc[indices, "race_id"].nunique() < 300:
            continue
        local = fit(features[indices], target[indices])
        strength = len(indices) / (len(indices) + 10000)
        result[key] = {"coef": strength * local["coef"] + (1-strength) * global_model["coef"],
                       "intercept": strength * local["intercept"] + (1-strength) * global_model["intercept"]}
    return result


def conditioned_predict(data, features, global_model, models, kind):
    output = predict(global_model, features)
    keys = condition_keys(data, kind)
    for key, model in models.items():
        idx = np.flatnonzero(keys.eq(key))
        output[idx] = predict(model, features[idx])
    return output


def interval(values, dates):
    """Date-cluster bootstrap: horses/races on the same day are not independent."""
    tab = pd.DataFrame({"value": np.asarray(values, dtype=float), "date": np.asarray(dates)})
    daily = tab.groupby("date").value.agg(["sum", "count"]).to_numpy()
    if len(daily) < 30:
        return None
    rng = np.random.default_rng(20260929)
    idx = rng.integers(0, len(daily), size=(1000, len(daily)))
    sampled = daily[idx].sum(axis=1)
    return np.round(np.quantile(sampled[:, 0] / sampled[:, 1], [.025, .975]), 6).tolist()


def top5_hits(data, scores, target):
    ranks = pd.Series(scores, index=data.index).groupby(data.race_id).rank(method="first", ascending=False)
    actual = data.loc[data.finish_position.eq(target)]
    actual = actual.loc[actual.groupby("race_id").race_id.transform("size").eq(1)]
    return ranks.loc[actual.index].le(5).astype(int)


def stats(values):
    a = np.asarray(values, dtype=float)
    return {"samples": len(a), "hits": int(a.sum()), "rate": round(float(a.mean()), 6) if len(a) else None}


def signal_audit(data, choose, kind):
    """Compare to exactly matched popularity, venue, and field-size-band baselines.

    Both rates are descriptive out-of-sample associations. Final popularity is
    used here; live popularity may change. No expected-return assertion.
    """
    population = data.loc[data.popularity.between(1, 3) if kind == "danger" else data.popularity.ge(4)].copy()
    population["sizeBand"] = np.where(population.fieldSize <= 8, "small", "large")
    population["placed"] = population.finish_position.le(3).astype(int)
    matched = population.groupby(["racecourse", "sizeBand", "popularity"]).placed.transform("mean")
    selected = choose.reindex(population.index, fill_value=False)
    sample = population.loc[selected]
    delta = population.placed.loc[selected] - matched.loc[selected]
    ci = interval(delta, sample.race_date)
    return {**stats(sample.placed), "baseline": round(float(matched.loc[selected].mean()), 6) if len(sample) else None,
            "difference": round(float(delta.mean()), 6) if len(sample) else None, "differenceCI": ci,
            "win": stats(sample.finish_position.eq(1)), "tenPlus": stats(sample.loc[sample.popularity.ge(10), "placed"])}


def insights(data, scores):
    df = data.copy()
    df["rank"] = pd.Series(scores, index=df.index).groupby(df.race_id).rank(method="first", ascending=False)
    df["fieldSize"] = df.groupby("race_id").race_id.transform("size")
    df["weight"] = 1 / (1 + np.exp(-np.clip(scores, -40, 40)))
    select, test = df.loc[df.race_date.between("2025-01-01", "2025-12-31")], df.loc[df.race_date.ge("2026-01-01")]
    signals = {}
    for kind in ("danger", "longshot"):
        choices = []
        for gap in (2, 4, 6):
            def rule(d):
                if kind == "danger":
                    return d.popularity.between(1, 3) & d["rank"].ge(d.popularity + gap)
                return d.popularity.ge(4) & d["rank"].le(5) & (d.popularity - d["rank"]).ge(gap)
            selection = signal_audit(select, rule(select), kind)
            choices.append({"gap": gap, "selection": selection, "audit": signal_audit(test, rule(test), kind)})
        eligible = [c for c in choices if c["selection"]["samples"] >= 300 and c["selection"]["differenceCI"] and
                    (c["selection"]["differenceCI"][1] < 0 if kind == "danger" else c["selection"]["differenceCI"][0] > 0)]
        best = max(eligible, key=lambda c: (-1 if kind == "danger" else 1) * c["selection"]["difference"]) if eligible else None
        passed = bool(best and best["audit"]["samples"] >= 300 and best["audit"]["differenceCI"] and
                      (best["audit"]["differenceCI"][1] < 0 if kind == "danger" else best["audit"]["differenceCI"][0] > 0))
        signals[kind] = {"status": "adopted" if passed else "rejected", "gap": best["gap"] if passed else None,
                         "audit": best["audit"] if best else None, "candidates": choices}
    races = []
    for rid, g in df.loc[df.race_date.ge("2025-01-01")].groupby("race_id", sort=False):
        n = len(g)
        if n < 6 or g.finish_position.eq(1).sum() != 1:
            continue
        top = g.loc[g["rank"].le(3)]
        share = float(top.weight.sum() / g.weight.sum())
        # Remove the mechanical concentration caused by small fields.
        excess = (share - 3/n) / (1 - 3/n)
        races.append({"date": g.race_date.iloc[0], "excess": excess, "share": share,
                      "winner": int(top.finish_position.eq(1).any()), "twoPlaced": int(top.finish_position.le(3).sum() >= 2)})
    rt = pd.DataFrame(races)
    sel = rt.loc[rt.date.lt("2026-01-01")]
    cut = np.quantile(sel.excess, [.25, .5, .75]).tolist()
    bins = []
    for number in range(4):
        record = {"bin": number}
        for label, subset in (("selection", sel), ("audit", rt.loc[rt.date.ge("2026-01-01")])):
            rows = subset.loc[np.searchsorted(cut, subset.excess, side="right") == number]
            record[label] = {"winner": stats(rows.winner), "twoPlaced": stats(rows.twoPlaced)}
        bins.append(record)
    monotonic = all(bins[i][p]["winner"]["rate"] <= bins[i+1][p]["winner"]["rate"] for p in ("selection", "audit") for i in range(3))
    sufficient = all(b[p]["winner"]["samples"] >= 300 for b in bins for p in ("selection", "audit"))
    signals["confidence"] = {"status": "adopted" if monotonic and sufficient else "rejected", "thresholds": cut,
                             "bins": bins, "minimumFieldSize": 6, "target": "1着適性上位3頭に勝ち馬が含まれる割合"}
    return signals


def tendencies(data):
    """Display exact-condition historical tendencies, not invented corrections."""
    df = data.loc[data.race_date.ge("2025-01-01") & data.popularity.notna()].copy()
    df["period"] = np.where(df.race_date.lt("2026-01-01"), "selection", "audit")
    df["band"] = distance_band(df.distance_m)
    result = []
    for kind, keys in (("course", ["racecourse", "surface"]), ("courseDistance", ["racecourse", "surface", "band"]), ("courseGoing", ["racecourse", "surface", "going"])):
        for key, group in df.groupby(keys, observed=True):
            key = key if isinstance(key, tuple) else (key,)
            periods = {}
            for period, part in group.groupby("period"):
                winners = part.loc[part.finish_position.eq(1)]
                periods[period] = {"races": int(part.race_id.nunique()), "favoriteWinner": stats(winners.popularity.eq(1)),
                                   "top3PopularityWinner": stats(winners.popularity.le(3)), "tenPlusWinner": stats(winners.popularity.ge(10))}
            if all(periods.get(p, {}).get("races", 0) >= 100 for p in ("selection", "audit")):
                result.append({"kind": kind, "key": "|".join(str(k) for k in key), **periods})
    return result


def run(input_file, output_dir):
    report_path = output_dir / "report.json"
    report = json.loads(report_path.read_text())
    data = pd.read_parquet(input_file)
    corners = int(data.get("corner_positions", pd.Series(dtype=str)).notna().sum())
    data = data.loc[data.finish_position.notna()].sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    data["race_date"] = pd.to_datetime(data.race_date).dt.strftime("%Y-%m-%d")
    features = inputs_by_mode(prior_features(data), data.race_id)["hybrid"]
    train = data.race_date.lt("2025-01-01").to_numpy()
    select = data.race_date.between("2025-01-01", "2025-12-31").to_numpy()
    test = data.race_date.ge("2026-01-01").to_numpy()
    roles, details, final_scores = {}, {}, None
    for target in (1, 2, 3):
        print(f"Condition audit target {target}", flush=True)
        y = data.finish_position.eq(target).to_numpy()
        base = fit(features[train], y[train])
        baseline = predict(base, features)
        base_selection = audit(data.loc[select], baseline[select], target)
        base_audit = audit(data.loc[test], baseline[test], target)
        candidates, score_cache = {}, {}
        for kind in ("course", "courseDistance", "courseGoing"):
            models = local_models(data, features, y, train, kind, base)
            scores = conditioned_predict(data, features, base, models, kind)
            candidates[kind] = {"groups": len(models), "selection": audit(data.loc[select], scores[select], target),
                                "audit": audit(data.loc[test], scores[test], target)}
            score_cache[kind] = scores
            print(f" {kind}: {candidates[kind]}", flush=True)
        best = max(candidates, key=lambda k: candidates[k]["selection"]["1"]["rate"])
        proposed = score_cache[best]
        a = top5_hits(data.loc[test], proposed[test], target)
        b = top5_hits(data.loc[test], baseline[test], target)
        ci = interval(a-b, data.loc[a.index, "race_date"])
        selection_gain = candidates[best]["selection"]["1"]["rate"] - base_selection["1"]["rate"]
        audit_gain = candidates[best]["audit"]["1"]["rate"] - base_audit["1"]["rate"]
        # Predeclared conservative gate, including the user's non-favorite target.
        adopted = bool(selection_gain >= .003 and audit_gain > 0 and ci and ci[0] > 0 and
                       candidates[best]["audit"]["4"]["rate"] >= base_audit["4"]["rate"])
        used = proposed if adopted else baseline
        per_course = []
        for course, part in data.loc[test].groupby("racecourse"):
            per_course.append({"course": course, "baseline": audit(part, baseline[part.index], target),
                               "candidate": audit(part, proposed[part.index], target)})
        details[str(target)] = {"status": "adopted" if adopted else "rejected", "selectedKind": best,
                               "baselineSelection": base_selection, "baselineAudit": base_audit,
                               "selectionGain": round(selection_gain, 6), "auditGain": round(audit_gain, 6),
                               "auditGainCI": ci, "candidates": candidates, "byCourse": per_course}
        if adopted:
            all_mask = np.ones(len(data), dtype=bool)
            fitted = fit(features, y)
            models = local_models(data, features, y, all_mask, best, fitted)
            roles[str(target)] = {"kind": best, "models": {k: serial(v) for k, v in models.items()}}
            # Publish the matching global fallback rather than silently mixing fits.
            report["live_model"]["roles"][str(target)] = {"mode": "hybrid", **serial(fitted)}
        if target == 1:
            final_scores = used
    result = {"version": "nar-conditions-v1", "periods": {"train": "2019–2024", "selection": "2025", "audit": f"2026-01-01–{data.race_date.max()}"},
              "limitations": ["2026年は過去モデルの監査にも使用した期間。完全な新規前向き検証ではない。", "人気関連は確定人気による事後監査。発走前人気との差と回収率は未検証。", "場別の比較は観察的な関連で、因果効果ではない。"],
              "ranking": details, "signals": insights(data, final_scores), "tendencies": tendencies(data),
              "pace": {"status": "insufficient", "cornerRows": corners, "reason": "旧取得データに各馬の通過順が未保存。順位・馬身差・内外位置の精度は検証未完了。"}}
    report["live_model"]["conditionalRoles"] = roles
    report["live_model"]["conditionValidation"] = result
    (output_dir / "condition-validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    report_path.write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    if report_path.stat().st_size > 890_000:
        raise ValueError("Candidate report exceeds safe broker payload size")
    lines = ["# 地方条件別検証", "", "選択2025年・監査2026年。人気は確定人気であり、前向き回収率の検証ではありません。", "", "|着順|採否|選択条件|選択年差|監査年差|監査差95%区間|", "|---|---|---|---|---|---|"]
    for target, d in details.items():
        lines.append(f"|{target}|{d['status']}|{d['selectedKind']}|{d['selectionGain']:+.4f}|{d['auditGain']:+.4f}|{d['auditGainCI']}|")
    for name, d in result["signals"].items():
        lines.append(f"\n{name}: {d['status']} — {json.dumps(d.get('audit', d.get('bins')), ensure_ascii=False)}")
    lines.append(f"\nコーナー検証: {result['pace']['reason']} ({corners} rows)")
    (output_dir / "condition-summary.md").write_text("\n".join(lines)+"\n")
    print("Condition validation complete", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-file", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    run(args.input_file, args.output_dir)
