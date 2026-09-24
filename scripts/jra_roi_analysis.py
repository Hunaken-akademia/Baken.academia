from __future__ import annotations
import json
from pathlib import Path
import lightgbm as lgb
import numpy as np
import pandas as pd

from rein_research import prepare
from rein_research_v3 import add_v3_features
from baken_academia.features import build_feature_frame
from baken_academia.all_bet_hit_rate import BET_CAPS
from rein_ticket_research_v4 import generate_all, MIXES
from baken_academia.expected_value import choose_threshold, select_bets, evaluate_bets, normalize_per_race

COURSE_CODE = {
    "01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京",
    "06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉",
}
UNORDERED={"bracket_quinella","quinella","wide","trio"}
GROUPS=("main","counter","longshot","combined")

def add_recent3_fastest_closing(x):
    """Point-in-time count of fastest final-3F performances in the prior three starts."""
    z=x.sort_values(["race_date","race_id","horse_number"]).copy()
    closing=pd.to_numeric(z["avg_1f"],errors="coerce").where(z["surface"].isin(["芝","ダート"]))
    race_min=closing.groupby(z["race_id"],observed=True).transform("min")
    fastest=(closing-race_min).abs().le(1e-9).astype(float)
    prior=fastest.groupby(z["horse_id"],observed=True).shift(1)
    z["recent3_fastest_closing_count"]=(
        prior.groupby(z["horse_id"],observed=True)
        .rolling(3,min_periods=1).sum().reset_index(level=0,drop=True)
    )
    return z.sort_index()

def load_many(paths):
    frames=[pd.read_parquet(p) for p in paths if p.stat().st_size]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

def make_selection(row):
    vals=[row.get("selection_1"),row.get("selection_2"),row.get("selection_3")]
    vals=[int(v) for v in vals if pd.notna(v)]
    if row["bet_type"] in UNORDERED:
        vals=sorted(vals)
    return tuple(vals)

def train_roles(raw):
    x=add_recent3_fastest_closing(prepare(raw))
    x, added = add_v3_features(x)
    base, _, _ = build_feature_frame(x)
    inherited=[c for c in x if (c.startswith(("prior_","recent3_")) or "_recent90_" in c) and c!="recent3_fastest_closing_count"]
    inherited += ["expected_front_count","relative_early"]
    feature_names=list(dict.fromkeys(inherited+added))
    frame=pd.concat([base, x[feature_names]], axis=1)
    enhanced=pd.concat([frame,x[["recent3_fastest_closing_count"]]],axis=1)
    flat=x["surface"].isin(["芝","ダート"])
    train=x["race_date"].lt("2025-01-01") & flat
    for role,pos in (("first",1),("second",2),("third",3)):
        y=pd.to_numeric(x["finish_position"], errors="coerce").eq(pos)
        model=lgb.LGBMClassifier(
            n_estimators=650,learning_rate=.03,num_leaves=15,min_child_samples=250,
            feature_fraction=.8,bagging_fraction=.9,bagging_freq=1,reg_lambda=8,
            n_jobs=4,verbosity=-1,random_state=900+pos,
        )
        model.fit(frame.loc[train],y.loc[train])
        x[f"v4_{role}_probability"]=model.predict_proba(frame)[:,1]
        if role=="first":
            candidate=lgb.LGBMClassifier(
                n_estimators=650,learning_rate=.03,num_leaves=15,min_child_samples=250,
                feature_fraction=.8,bagging_fraction=.9,bagging_freq=1,reg_lambda=8,
                n_jobs=4,verbosity=-1,random_state=900+pos,
            )
            candidate.fit(enhanced.loc[train],y.loc[train])
            x["candidate_first_probability"]=candidate.predict_proba(enhanced)[:,1]
    x["win_probability"]=x["v4_first_probability"]
    candidate=x.copy()
    candidate["v4_first_probability"]=candidate["candidate_first_probability"]
    candidate["win_probability"]=candidate["candidate_first_probability"]
    return x,candidate

def ticket_roi(tickets,payouts):
    payouts=payouts.copy()
    payouts["race_id"]=payouts["race_id"].astype(str)
    payouts["selection"]=payouts.apply(make_selection,axis=1)
    payout_map=payouts.groupby(["race_id","bet_type","selection"],observed=True)["payout_yen_per_100"].max()
    t=tickets.copy()
    t["race_id"]=t["race_id"].astype(str)
    t["selection"]=t["selection"].map(tuple)
    t["payout"]=[
        float(payout_map.get((rid,bt,sel),0.0))
        for rid,bt,sel in zip(t["race_id"],t["bet_type"],t["selection"])
    ]
    t["hit"]=t["payout"].gt(0)
    out={}
    for bet_type in BET_CAPS:
        out[bet_type]={}
        bet=t.loc[t["bet_type"].eq(bet_type)]
        for group in ("main","counter","longshot","combined"):
            g=bet if group=="combined" else bet.loc[bet["ticket_type"].eq(group)]
            races=g["race_id"].nunique()
            stake=len(g)*100
            ret=float(g["payout"].sum())
            per_race=g.groupby("race_id",observed=True)["hit"].any() if races else pd.Series(dtype=bool)
            out[bet_type][group]={
                "races":int(races),"bets":int(len(g)),
                "race_hits":int(per_race.sum()),"ticket_hits":int(g["hit"].sum()),
                "points_per_race":float(len(g)/races) if races else 0.0,
                "race_hit_rate":float(per_race.mean()) if races else 0.0,
                "ticket_hit_rate":float(g["hit"].mean()) if len(g) else 0.0,
                "stake_yen":int(stake),"return_yen":ret,
                "profit_yen":ret-stake,"return_rate":ret/stake if stake else 0.0,
            }
    return out,t

def frame_result(frame):
    races=int(frame["race_id"].nunique())
    bets=int(len(frame))
    stake=bets*100
    returned=float(frame["payout"].sum())
    per_race=frame.groupby("race_id",observed=True)["hit"].any() if races else pd.Series(dtype=bool)
    return {
        "races":races,"bets":bets,
        "race_hits":int(per_race.sum()),"ticket_hits":int(frame["hit"].sum()),
        "points_per_race":float(bets/races) if races else 0.0,
        "race_hit_rate":float(per_race.mean()) if races else 0.0,
        "ticket_hit_rate":float(frame["hit"].mean()) if bets else 0.0,
        "stake_yen":stake,"return_yen":returned,
        "profit_yen":returned-stake,
        "return_rate":returned/stake if stake else 0.0,
    }

def checked_roi(checked):
    out={}
    for bet_type in BET_CAPS:
        out[bet_type]={}
        bet=checked.loc[checked["bet_type"].eq(bet_type)]
        for group in GROUPS:
            g=bet if group=="combined" else bet.loc[bet["ticket_type"].eq(group)]
            out[bet_type][group]=frame_result(g)
    return out

def recent3_fastest_ticket_comparison(base_tune,candidate_tune,base_audit,candidate_audit):
    periods={
        "tune_2025_h1":(
            base_tune.loc[base_tune["race_date"].lt("2025-07-01")],
            candidate_tune.loc[candidate_tune["race_date"].lt("2025-07-01")],
        ),
        "tune_2025_h2":(
            base_tune.loc[base_tune["race_date"].ge("2025-07-01")],
            candidate_tune.loc[candidate_tune["race_date"].ge("2025-07-01")],
        ),
        "audit_2026":(base_audit,candidate_audit),
    }
    result={"scope":"Only the first-place role model adds recent3_fastest_closing_count; production is unchanged","bet_types":{}}
    summaries={name:(checked_roi(base),checked_roi(candidate)) for name,(base,candidate) in periods.items()}
    for bet_type in BET_CAPS:
        result["bet_types"][bet_type]={}
        for group in GROUPS:
            rows={}
            for period,(baseline,candidate) in summaries.items():
                b=baseline[bet_type][group]; c=candidate[bet_type][group]
                rows[period]={
                    "baseline":b,"candidate":c,
                    "return_rate_change_pp":100*(c["return_rate"]-b["return_rate"]),
                    "race_hit_rate_change_pp":100*(c["race_hit_rate"]-b["race_hit_rate"]),
                }
            stable_improvement=all(rows[p]["return_rate_change_pp"]>0 for p in rows)
            profitable_all=all(rows[p]["candidate"]["return_rate"]>=1 for p in rows)
            enough_data=all(rows[p]["candidate"]["races"]>=100 for p in rows)
            result["bet_types"][bet_type][group]={
                "periods":rows,
                "stable_improvement":stable_improvement,
                "profitable_all_periods":profitable_all,
                "adoption_candidate":stable_improvement and profitable_all and enough_data,
            }
    result["adoption_candidates"]=[
        {"bet_type":bet_type,"group":group}
        for bet_type,groups in result["bet_types"].items()
        for group,value in groups.items() if value["adoption_candidate"]
    ]
    result["production_applied"]=False
    return result

def normalized_win_place(win_place):
    wp=win_place.copy()
    wp["race_date"]=pd.to_datetime(wp["race_date"])
    wp["racecourse"]=wp["course_code"].astype(str).str.zfill(2).map(COURSE_CODE)
    wp=wp.loc[wp["racecourse"].notna()].copy()
    wp["race_id"]=wp["race_date"].dt.strftime("%Y%m%d")+"-"+wp["racecourse"]+"-"+wp["race_no"].astype(int).astype(str).str.zfill(2)
    wp["horse_number"]=pd.to_numeric(wp["horse_number"],errors="coerce")
    for col in ("win_odds","place_odds_min","place_odds_max"):
        if col in wp:
            wp[col]=pd.to_numeric(wp[col],errors="coerce")
    if {"place_odds_min","place_odds_max"}.issubset(wp):
        wp["place_odds"]=(wp["place_odds_min"]+wp["place_odds_max"])/2
    return wp

def add_ticket_context(checked,runners,win_place):
    t=checked.copy()
    race_ids=set(t["race_id"].astype(str).unique())
    runner=runners.loc[runners["race_id"].astype(str).isin(race_ids)].copy()
    runner["race_id"]=runner["race_id"].astype(str)
    runner["horse_number"]=pd.to_numeric(runner["horse_number"],errors="coerce")
    pop_lookup=runner.set_index(["race_id","horse_number"])["popularity"].to_dict()

    def popularity_stats(row):
        values=[pd.to_numeric(pop_lookup.get((str(row.race_id),float(n))),errors="coerce") for n in row.selection]
        values=[float(v) for v in values if pd.notna(v)]
        return (min(values),max(values),sum(values)/len(values)) if values else (np.nan,np.nan,np.nan)

    stats=t.apply(popularity_stats,axis=1,result_type="expand")
    stats.columns=["best_popularity","worst_popularity","mean_popularity"]
    t=pd.concat([t,stats],axis=1)

    race_cols=["race_id","racecourse","surface","going","distance_m","field_size"]
    available=[c for c in race_cols if c in runner]
    race=runner.sort_values(["race_id","horse_number"]).drop_duplicates("race_id")[available]
    if "racecourse" not in race:
        race["racecourse"]=race["race_id"].str.split("-").str[1]
    if "field_size" not in race:
        sizes=runner.groupby("race_id",observed=True).size().rename("field_size")
        race=race.merge(sizes,on="race_id",how="left")
    direction={"東京":"左","中京":"左","新潟":"左"}
    race["direction"]=race["racecourse"].map(direction).fillna("右")

    gaps=[]
    for rid,g in runner.groupby("race_id",sort=False,observed=True):
        values=pd.to_numeric(g["v4_first_probability"],errors="coerce").dropna().sort_values(ascending=False).to_numpy()
        gaps.append((rid,float(values[0]-values[1]) if len(values)>1 else np.nan,float(values[0]) if len(values) else np.nan))
    gap=pd.DataFrame(gaps,columns=["race_id","first_probability_gap","top_first_probability"])
    race=race.merge(gap,on="race_id",how="left")
    t=t.merge(race,on="race_id",how="left")

    wp=normalized_win_place(win_place)
    odds=wp[[c for c in ["race_id","horse_number","win_odds","place_odds"] if c in wp]].drop_duplicates(["race_id","horse_number"])
    odds_lookup=odds.set_index(["race_id","horse_number"]).to_dict()
    def final_odds(row):
        if row.bet_type not in {"win","place"} or len(row.selection)!=1:
            return np.nan
        col="win_odds" if row.bet_type=="win" else "place_odds"
        return odds_lookup.get(col,{}).get((str(row.race_id),float(row.selection[0])),np.nan)
    t["final_odds"]=t.apply(final_odds,axis=1)
    t["group_points"]=t.groupby(["race_id","bet_type","ticket_type"],observed=True)["race_id"].transform("size")
    return t

def breakdown(checked,column,bins,labels):
    work=checked.loc[checked[column].notna()].copy()
    work["band"]=pd.cut(work[column],bins=bins,labels=labels,include_lowest=True,right=False)
    result={}
    for bet_type in BET_CAPS:
        result[bet_type]={}
        bet=work.loc[work["bet_type"].eq(bet_type)]
        for group in GROUPS:
            g=bet if group=="combined" else bet.loc[bet["ticket_type"].eq(group)]
            result[bet_type][group]={str(label):frame_result(g.loc[g["band"].eq(label)]) for label in labels}
    return result

def categorical_breakdown(checked,column):
    result={}
    values=[v for v in checked[column].dropna().unique().tolist()]
    for bet_type in BET_CAPS:
        result[bet_type]={}
        bet=checked.loc[checked["bet_type"].eq(bet_type)]
        for group in GROUPS:
            g=bet if group=="combined" else bet.loc[bet["ticket_type"].eq(group)]
            result[bet_type][group]={str(v):frame_result(g.loc[g[column].eq(v)]) for v in values}
    return result

def filter_candidates(tune_checked,audit_checked):
    candidates={}
    for bet_type in BET_CAPS:
        candidates[bet_type]={}
        for group in GROUPS:
            tune=tune_checked.loc[tune_checked["bet_type"].eq(bet_type)]
            audit=audit_checked.loc[audit_checked["bet_type"].eq(bet_type)]
            if group!="combined":
                tune=tune.loc[tune["ticket_type"].eq(group)]
                audit=audit.loc[audit["ticket_type"].eq(group)]
            base_tune=frame_result(tune); base_audit=frame_result(audit)
            tune_h1=tune.loc[tune["race_date"].lt("2025-07-01")]
            tune_h2=tune.loc[tune["race_date"].ge("2025-07-01")]
            base_h1=frame_result(tune_h1); base_h2=frame_result(tune_h2)
            scans=[]
            definitions=[]
            for q in (.25,.5,.75,.9):
                value=float(tune["probability"].quantile(q))
                definitions.append((f"probability_gte_q{int(q*100)}",lambda x,v=value:x["probability"].ge(v),value))
            for max_pop in (3,5,8,10):
                definitions.append((f"worst_popularity_lte_{max_pop}",lambda x,v=max_pop:x["worst_popularity"].le(v),max_pop))
            for q in (.5,.75,.9):
                value=float(tune["first_probability_gap"].quantile(q))
                definitions.append((f"first_gap_gte_q{int(q*100)}",lambda x,v=value:x["first_probability_gap"].ge(v),value))
            if bet_type in {"win","place"}:
                for lo,hi in ((1,3),(3,5),(5,10),(10,20),(20,50),(50,1e9)):
                    definitions.append((f"final_odds_{lo:g}_{hi:g}",lambda x,a=lo,b=hi:x["final_odds"].ge(a)&x["final_odds"].lt(b),[lo,hi]))
            for name,predicate,value in definitions:
                tuned=tune.loc[predicate(tune)]
                audited=audit.loc[predicate(audit)]
                tr=frame_result(tuned); ar=frame_result(audited)
                if tr["races"]<150 or tr["bets"]<300:
                    continue
                h1=frame_result(tune_h1.loc[predicate(tune_h1)])
                h2=frame_result(tune_h2.loc[predicate(tune_h2)])
                scans.append({"condition":name,"value":value,"tune_2025":tr,"tune_2025_h1":h1,"tune_2025_h2":h2,"audit_2026":ar})
            scans.sort(key=lambda x:(x["tune_2025"]["return_rate"],x["tune_2025"]["races"]),reverse=True)
            chosen=scans[0] if scans else None
            if chosen:
                chosen=dict(chosen)
                chosen["audit_return_rate_change_pp"]=100*(chosen["audit_2026"]["return_rate"]-base_audit["return_rate"])
                chosen["stable_improvement"]=bool(
                    chosen["tune_2025"]["return_rate"]>base_tune["return_rate"] and
                    chosen["tune_2025_h1"]["return_rate"]>base_h1["return_rate"] and
                    chosen["tune_2025_h2"]["return_rate"]>base_h2["return_rate"] and
                    chosen["audit_2026"]["return_rate"]>base_audit["return_rate"] and
                    min(chosen["tune_2025_h1"]["races"],chosen["tune_2025_h2"]["races"],chosen["audit_2026"]["races"])>=100
                )
                chosen["profitable_all_periods"]=bool(min(chosen["tune_2025_h1"]["return_rate"],chosen["tune_2025_h2"]["return_rate"],chosen["audit_2026"]["return_rate"])>=1.0)
                chosen["adoption_candidate"]=bool(chosen["stable_improvement"] and chosen["profitable_all_periods"])
            candidates[bet_type][group]={"baseline_tune_2025":base_tune,"baseline_tune_2025_h1":base_h1,"baseline_tune_2025_h2":base_h2,"baseline_audit_2026":base_audit,"selected_on_2025":chosen,"top_2025_scans":scans[:5]}
    return candidates

def role_rank_metrics(runners):
    audit=runners.loc[runners["race_date"].ge("2026-01-01") & runners["surface"].isin(["芝","ダート"])].copy()
    result={}
    for role,position in (("first",1),("second",2),("third",3)):
        score=f"v4_{role}_probability"
        audit["role_rank"]=audit.groupby("race_id",observed=True)[score].rank(method="first",ascending=False)
        per_rank=[]
        cumulative=[]
        for rank in range(1,6):
            selected=audit.loc[audit["role_rank"].eq(rank)]
            per_rank.append({
                "rank":rank,"horses":int(len(selected)),
                "actual_position_rate":float(pd.to_numeric(selected["finish_position"],errors="coerce").eq(position).mean()),
            })
            actual=audit.loc[pd.to_numeric(audit["finish_position"],errors="coerce").eq(position)]
            cumulative.append({
                "top_n":rank,"races":int(actual["race_id"].nunique()),
                "actual_horse_in_top_n_rate":float(actual["role_rank"].le(rank).mean()),
            })
        result[role]={"target_finish_position":position,"per_rank":per_rank,"cumulative":cumulative}
    return result

def win_ev(runners,win_place,raw):
    wp=win_place.copy()
    wp["race_date"]=pd.to_datetime(wp["race_date"])
    wp["racecourse"]=wp["course_code"].astype(str).str.zfill(2).map(COURSE_CODE)
    wp=wp.loc[wp["racecourse"].notna() & wp["win_odds"].notna()].copy()
    wp["race_id"]=wp["race_date"].dt.strftime("%Y%m%d")+"-"+wp["racecourse"]+"-"+wp["race_no"].astype(int).astype(str).str.zfill(2)
    wp["horse_number"]=pd.to_numeric(wp["horse_number"],errors="coerce")
    wp["win_odds"]=pd.to_numeric(wp["win_odds"],errors="coerce")

    frame=runners.copy()
    frame["race_id"]=frame["race_id"].astype(str)
    frame["race_date"]=pd.to_datetime(frame["race_date"])
    pop=pd.to_numeric(frame["popularity"],errors="coerce")
    fallback=pop.groupby(frame["race_id"]).transform("max").fillna(18)+1
    market=1/pop.fillna(fallback).clip(lower=1)
    market=market/market.groupby(frame["race_id"]).transform("sum")
    learned=pd.to_numeric(frame["v4_first_probability"],errors="coerce").clip(lower=1e-9)
    learned=learned/learned.groupby(frame["race_id"]).transform("sum")
    frame["win_probability"]=.7*market+.3*learned
    frame=frame.merge(wp[["race_id","horse_number","win_odds"]],on=["race_id","horse_number"],how="left")
    # The scored runner frame normally already carries the observed finish.
    # Only join it from the raw data when it is genuinely absent; otherwise
    # pandas suffixes the two copies and removes the canonical column name.
    if "finish_position" not in frame.columns:
        winners=raw[["race_id","horse_number","finish_position"]].copy()
        winners["race_id"]=winners["race_id"].astype(str)
        winners["horse_number"]=pd.to_numeric(winners["horse_number"],errors="coerce")
        frame=frame.merge(winners,on=["race_id","horse_number"],how="left")
    frame["is_win"]=pd.to_numeric(frame["finish_position"],errors="coerce").eq(1)
    eligible=frame.loc[frame["win_odds"].notna() & frame["win_odds"].gt(0)].copy()
    calibration=eligible.loc[eligible["race_date"].between("2025-03-01","2025-07-31")].copy()
    validation=eligible.loc[eligible["race_date"].between("2025-08-01","2025-12-31")].copy()
    test=eligible.loc[eligible["race_date"].ge("2026-01-01")].copy()
    if min(calibration["race_id"].nunique(),validation["race_id"].nunique(),test["race_id"].nunique())==0:
        return {"error":"insufficient EV split coverage","rows":int(len(eligible))}
    from sklearn.isotonic import IsotonicRegression
    cal=IsotonicRegression(out_of_bounds="clip",y_min=1e-6,y_max=1-1e-6)
    cal.fit(calibration["win_probability"],calibration["is_win"])
    for f in (validation,test):
        f["calibrated_probability"]=normalize_per_race(cal.predict(f["win_probability"]),f["race_id"])
    threshold,scan=choose_threshold(validation)
    test_bets=select_bets(test,threshold)
    baseline=test.loc[test.groupby("race_id",observed=True)["win_probability"].idxmax()].copy()
    return {
        "threshold":threshold,
        "coverage_rows":int(len(eligible)),
        "coverage_races":int(eligible["race_id"].nunique()),
        "test":evaluate_bets(test_bets),
        "baseline":evaluate_bets(baseline),
        "threshold_scan":scan,
    }

def main():
    raw=pd.read_parquet("data/raw/jra/races-2019-2026.parquet")
    raw["race_id"]=raw["race_id"].astype(str)
    raw["race_date"]=pd.to_datetime(raw["race_date"])
    runners,candidate_runners=train_roles(raw)
    tune=runners.loc[runners["race_date"].between("2025-01-01","2025-12-31")].copy()
    audit=runners.loc[runners["race_date"].ge("2026-01-01")].copy()
    candidate_tune=candidate_runners.loc[candidate_runners["race_date"].between("2025-01-01","2025-12-31")].copy()
    candidate_audit=candidate_runners.loc[candidate_runners["race_date"].ge("2026-01-01")].copy()
    tune_tickets=generate_all(tune, MIXES["market70_role30"])
    tickets=generate_all(audit, MIXES["market70_role30"])
    candidate_tune_tickets=generate_all(candidate_tune,MIXES["market70_role30"])
    candidate_tickets=generate_all(candidate_audit,MIXES["market70_role30"])
    payouts=load_many(list(Path(".odds-normalized/payouts").glob("*.parquet")))
    win_place=load_many(list(Path(".odds-normalized/win-place").glob("*.parquet")))
    _,tune_checked=ticket_roi(tune_tickets,payouts)
    roi,checked=ticket_roi(tickets,payouts)
    _,candidate_tune_checked=ticket_roi(candidate_tune_tickets,payouts)
    _,candidate_checked=ticket_roi(candidate_tickets,payouts)
    tune_checked=add_ticket_context(tune_checked,runners,win_place)
    checked=add_ticket_context(checked,runners,win_place)
    candidate_tune_checked=add_ticket_context(candidate_tune_checked,candidate_runners,win_place)
    candidate_checked=add_ticket_context(candidate_checked,candidate_runners,win_place)
    # EV calibration needs the full scored history: 2025 is used only for
    # calibration/threshold selection and 2026 remains the held-out audit.
    # Passing `audit` here leaves no 2025 rows and makes every split invalid.
    ev=win_ev(runners,win_place,raw)
    out=Path("reports/jra-roi-ev-v1"); out.mkdir(parents=True,exist_ok=True)
    report={
        "scope":"trained through 2024, filters selected on 2025, final audit on 2026 using market70_role30",
        "roi":roi,
        "win_expected_value":ev,
        "role_rank_top5_2026":role_rank_metrics(runners),
        "breakdowns_2026":{
            "model_probability":breakdown(checked,"probability",[-np.inf,.001,.0025,.005,.01,.02,.05,.1,.2,np.inf],["<0.1%","0.1-0.25%","0.25-0.5%","0.5-1%","1-2%","2-5%","5-10%","10-20%","20%+"]),
            "selection_popularity":breakdown(checked,"worst_popularity",[-np.inf,2,4,7,11,np.inf],["1人気","2-3人気","4-6人気","7-10人気","11人気以下"]),
            "final_odds_win_place_only":breakdown(checked,"final_odds",[-np.inf,2,3,5,10,20,50,np.inf],["<2倍","2-3倍","3-5倍","5-10倍","10-20倍","20-50倍","50倍+"]),
            "points_per_race":categorical_breakdown(checked,"group_points"),
            "racecourse":categorical_breakdown(checked,"racecourse"),
            "surface":categorical_breakdown(checked,"surface"),
            "going":categorical_breakdown(checked,"going"),
            "direction":categorical_breakdown(checked,"direction"),
            "distance_m":breakdown(checked,"distance_m",[-np.inf,1401,1801,2201,2601,np.inf],["1400m以下","1401-1800m","1801-2200m","2201-2600m","2601m超"]),
        },
        "filter_selection_2025_audit_2026":filter_candidates(tune_checked,checked),
        "recent3_fastest_ticket_test":recent3_fastest_ticket_comparison(
            tune_checked,candidate_tune_checked,checked,candidate_checked
        ),
        "limitations":["Final selection odds are available for win/place only. For the other six bet types, payout bands are post-race evaluation only and are not used to select bets."],
    }
    (out/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False))
    checked.to_parquet(out/"tickets-with-payouts.parquet",index=False)
    print(json.dumps(report,ensure_ascii=False))
if __name__=="__main__": main()
