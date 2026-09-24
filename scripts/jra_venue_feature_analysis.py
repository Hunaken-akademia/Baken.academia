from __future__ import annotations
import json
from pathlib import Path
import lightgbm as lgb
import numpy as np
import pandas as pd

from scripts.rein_research import prepare, metrics
from scripts.rein_research_v3 import add_v3_features
from baken_academia.features import build_feature_frame

DIRECTION={"札幌":"右","函館":"右","福島":"右","新潟":"左","東京":"左","中山":"右","中京":"左","京都":"右","阪神":"右","小倉":"右"}

def add_candidate_features(raw):
    x=raw.sort_values(["race_date","race_id","horse_number"]).copy()
    x["direction"]=x["racecourse"].map(DIRECTION)
    x["wet"]=x["going"].isin(["重","不良"]).astype(int)
    x["placed"]=pd.to_numeric(x["finish_position"],errors="coerce").between(1,3).astype(float)

    # prior direction / wet suitability, shifted so current result never leaks.
    for prefix,key in (("direction","direction"),("wet","wet")):
        if prefix=="direction":
            grp=x.groupby(["horse_id",key],observed=True,dropna=False)
        else:
            grp=x.groupby(["horse_id",key],observed=True,dropna=False)
        prior_n=grp.cumcount()
        prior_hits=grp["placed"].cumsum()-x["placed"]
        x[f"horse_{prefix}_prior_starts"]=prior_n.astype(float)
        x[f"horse_{prefix}_prior_top3_rate"]=(prior_hits+4.5)/(prior_n+20)

    closing=pd.to_numeric(x["avg_1f"],errors="coerce").where(x["surface"].isin(["芝","ダート"]))
    race_min=closing.groupby(x["race_id"],observed=True).transform("min")
    fastest=(closing-race_min).abs().le(1e-9).astype(float)
    prior_fastest=fastest.groupby(x["horse_id"],observed=True).shift(1)
    x["recent3_fastest_closing_count"]=(
        prior_fastest.groupby(x["horse_id"],observed=True)
        .rolling(3,min_periods=1).sum().reset_index(level=0,drop=True)
    )
    return x

def venue_summary(raw):
    z=raw.loc[raw["surface"].isin(["芝","ダート"])].copy()
    z["finish_position"]=pd.to_numeric(z["finish_position"],errors="coerce")
    z["gate"]=pd.to_numeric(z["gate"],errors="coerce")
    z["popularity"]=pd.to_numeric(z["popularity"],errors="coerce")
    rows=[]
    for course,g in z.groupby("racecourse",observed=True):
        winners=g.loc[g["finish_position"].eq(1)]
        top3=g.loc[g["finish_position"].between(1,3)]
        rows.append({
            "racecourse":course,"direction":DIRECTION.get(course),
            "races":int(g["race_id"].nunique()),
            "winner_avg_gate":float(winners["gate"].mean()),
            "top3_avg_gate":float(top3["gate"].mean()),
            "favorite_win_rate":float(g.loc[g["popularity"].eq(1),"finish_position"].eq(1).mean()),
            "favorite_top3_rate":float(g.loc[g["popularity"].eq(1),"finish_position"].between(1,3).mean()),
            "wet_race_share":float(g.groupby("race_id",observed=True)["going"].first().isin(["重","不良"]).mean()),
        })
    return rows

def train_compare(raw):
    x=prepare(raw)
    x=add_candidate_features(x)
    x,advanced=add_v3_features(x)
    base,_,_=build_feature_frame(x)
    inherited=[c for c in x if c.startswith(("prior_","recent3_")) or "_recent90_" in c]+["expected_front_count","relative_early"]
    standard=list(dict.fromkeys(inherited+advanced))
    added=["horse_direction_prior_starts","horse_direction_prior_top3_rate","horse_wet_prior_starts","horse_wet_prior_top3_rate","recent3_fastest_closing_count"]
    baseline=pd.concat([base,x[standard]],axis=1)
    enhanced=pd.concat([baseline,x[added]],axis=1)
    flat=x["surface"].isin(["芝","ダート"])
    train=x["race_date"].lt("2025-01-01") & flat
    audit=x["race_date"].ge("2026-01-01") & flat
    report={}
    for target in ("win","place"):
        y=x["finish_position"].eq(1) if target=="win" else x["finish_position"].between(1,3)
        report[target]={}
        preds={}
        for name,frame in (("baseline",baseline),("enhanced",enhanced)):
            model=lgb.LGBMClassifier(
                n_estimators=650,learning_rate=.03,num_leaves=15,min_child_samples=250,
                feature_fraction=.8,bagging_fraction=.9,bagging_freq=1,reg_lambda=8,
                n_jobs=4,verbosity=-1,random_state=1200+(target=="place"),
            )
            model.fit(frame.loc[train],y.loc[train])
            preds[name]=model.predict_proba(frame)[:,1]
            m,_=metrics(x.loc[audit],preds[name][audit])
            report[target][name]=m
        report[target]["change"]={
            "rank1_win_pp":100*(report[target]["enhanced"]["by_rank"][0]["win"]-report[target]["baseline"]["by_rank"][0]["win"]),
            "rank1_top3_pp":100*(report[target]["enhanced"]["by_rank"][0]["top3"]-report[target]["baseline"]["by_rank"][0]["top3"]),
            "winner_in_top3_pp":100*(report[target]["enhanced"]["winner_in_top3"]-report[target]["baseline"]["winner_in_top3"]),
            "two_placed_pp":100*(report[target]["enhanced"]["two_placed"]-report[target]["baseline"]["two_placed"]),
        }
    availability={c:(c in raw.columns) for c in ["blinkers","breeder","breeder_name","owner","owner_name"]}
    return report,availability

def main():
    raw=pd.read_parquet("data/raw/jra/races-2019-2026.parquet")
    raw["race_date"]=pd.to_datetime(raw["race_date"])
    comparison,availability=train_compare(raw)
    out=Path("reports/jra-venue-features-v1"); out.mkdir(parents=True,exist_ok=True)
    report={
        "venue_summary":venue_summary(raw),
        "feature_test":comparison,
        "data_availability":availability,
        "candidate_features":[
            "道悪適性（過去のみ）","右左回り適性（過去のみ）","前3走上がり最速回数"
        ],
        "not_yet_tested_if_unavailable":["初ブリンカー","社台グループ生産馬"],
    }
    (out/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False))
    pd.DataFrame(report["venue_summary"]).to_csv(out/"venue-summary.csv",index=False)
    print(json.dumps(report,ensure_ascii=False))
if __name__=="__main__": main()
