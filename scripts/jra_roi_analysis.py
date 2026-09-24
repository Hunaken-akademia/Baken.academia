from __future__ import annotations
import json
from pathlib import Path
import lightgbm as lgb
import numpy as np
import pandas as pd

from scripts.rein_research import prepare
from scripts.rein_research_v3 import add_v3_features
from baken_academia.features import build_feature_frame
from baken_academia.all_bet_hit_rate import BET_CAPS
from scripts.rein_ticket_research_v4 import generate_all, MIXES
from baken_academia.expected_value import choose_threshold, select_bets, evaluate_bets, normalize_per_race

COURSE_CODE = {
    "01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京",
    "06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉",
}
UNORDERED={"bracket_quinella","quinella","wide","trio"}

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
    x, added = add_v3_features(prepare(raw))
    base, _, _ = build_feature_frame(x)
    inherited=[c for c in x if c.startswith(("prior_","recent3_")) or "_recent90_" in c]
    inherited += ["expected_front_count","relative_early"]
    feature_names=list(dict.fromkeys(inherited+added))
    frame=pd.concat([base, x[feature_names]], axis=1)
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
    x["win_probability"]=x["v4_first_probability"]
    return x

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
                "points_per_race":float(len(g)/races) if races else 0.0,
                "race_hit_rate":float(per_race.mean()) if races else 0.0,
                "stake_yen":int(stake),"return_yen":ret,
                "profit_yen":ret-stake,"return_rate":ret/stake if stake else 0.0,
            }
    return out,t

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
    winners=raw[["race_id","horse_number","finish_position"]].copy()
    winners["race_id"]=winners["race_id"].astype(str)
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
    runners=train_roles(raw)
    audit=runners.loc[runners["race_date"].ge("2026-01-01")].copy()
    tickets=generate_all(audit, MIXES["market70_role30"])
    payouts=load_many(list(Path(".odds-normalized/payouts").glob("*.parquet")))
    win_place=load_many(list(Path(".odds-normalized/win-place").glob("*.parquet")))
    roi,checked=ticket_roi(tickets,payouts)
    ev=win_ev(audit,win_place,raw)
    out=Path("reports/jra-roi-ev-v1"); out.mkdir(parents=True,exist_ok=True)
    report={"scope":"2026 held-out style audit using market70_role30","roi":roi,"win_expected_value":ev}
    (out/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False))
    checked.to_parquet(out/"tickets-with-payouts.parquet",index=False)
    print(json.dumps(report,ensure_ascii=False))
if __name__=="__main__": main()
