from __future__ import annotations
import argparse,glob,io,json,tarfile
from pathlib import Path
import numpy as np,pandas as pd,sys

def load_odds(root):
 frames=[]
 for path in sorted(Path(root).rglob("jra-final-odds-*.tar.gz")):
  with tarfile.open(path,"r:gz") as t:
   members=[m for m in t.getmembers() if m.isfile() and m.name.endswith(".parquet")]
   if len(members)!=1:continue
   frames.append(pd.read_parquet(io.BytesIO(t.extractfile(members[0]).read()))[["race_id","horse_number","win_odds"]])
 x=pd.concat(frames,ignore_index=True);x["race_id"]=x.race_id.astype(str);x["horse_number"]=pd.to_numeric(x.horse_number).astype(int)
 return x.drop_duplicates(["race_id","horse_number"])
def main():
 p=argparse.ArgumentParser();p.add_argument("--bundle",required=True);p.add_argument("--research",required=True);p.add_argument("--odds",required=True);p.add_argument("--output",required=True);a=p.parse_args()
 out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
 with tarfile.open(a.bundle,"r:gz") as t:
  t.extractall(out/"bundle",filter="data")
 roots=[x for x in (out/"bundle").iterdir() if x.is_dir()];assert len(roots)==1;root=roots[0]
 sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"rein-web/api"))
 from rein_augmented_runtime import ReinRuntime
 runtime=ReinRuntime.load(root,root.name)
 assert runtime.market_models is not None
 raw=pd.read_parquet(root/"data/history.parquet");raw["race_id"]=raw.race_id.astype(str);raw["race_date"]=pd.to_datetime(raw.race_date)
 odds=load_odds(a.odds)
 expected={}
 for role in ("first","second","third"):
  q=pd.read_parquet(Path(a.research)/role/"predictions.parquet");q["race_id"]=q.race_id.astype(str)
  expected[role]=q.set_index(["race_id","horse_number"])
 ids=sorted(set(expected["first"].index.get_level_values(0)))
 dates=expected["first"].reset_index().drop_duplicates("race_id").set_index("race_id").race_date
 sample=list(dates[(pd.to_datetime(dates).between("2025-07-01","2025-12-31"))].index[::500])[:2]+list(dates[pd.to_datetime(dates).ge("2026-01-01")].index[::700])[:2]
 checks=[];maxerr=0.
 for rid in sample:
  race_rows=raw.loc[raw.race_id.eq(rid)].sort_values("horse_number").merge(odds.loc[odds.race_id.eq(rid)],on=["race_id","horse_number"],how="left",validate="one_to_one")
  if race_rows.win_odds.isna().any():continue
  first=race_rows.iloc[0]
  race={"race_date":str(pd.Timestamp(first.race_date).date()),"racecourse":first.racecourse,"surface":first.surface,"distance_m":float(first.distance_m),"going":first.going,"race_class":first.race_class}
  runners=[]
  for _,r in race_rows.iterrows():
   runners.append({"horse_number":int(r.horse_number),"gate":int(r.gate),"age":float(r.age),"sex":r.sex,"weight_carried":float(r.weight_carried),"horse_id":str(r.horse_id),"jockey_id":str(r.jockey_id),"trainer_id":str(r.trainer_id),"horse_weight":None if pd.isna(r.get("horse_weight")) else float(r.get("horse_weight")),"horse_weight_change":None if pd.isna(r.get("horse_weight_change")) else float(r.get("horse_weight_change")),"popularity":int(r.popularity),"win_odds":float(r.win_odds)})
  result=runtime.score(race,runners);assert result["market_difference_ready"]
  got={x["horse_number"]:x for x in result["runners"]}
  for role in ("first","second","third"):
   exp=expected[role].loc[rid]
   for number,row in exp.iterrows():
    number=int(number);g=got[number]
    for kind,col,prefix in (("market","real_odds_market","market"),("rein","real_odds_without_people","rein_market")):
     e=float(row[col]);v=float(g[f"{prefix}_{role}_probability"]);err=abs(e-v);maxerr=max(maxerr,err)
     checks.append({"race_id":rid,"horse_number":number,"role":role,"kind":kind,"expected":e,"actual":v,"abs_error":err})
 df=pd.DataFrame(checks);df.to_csv(out/"parity.csv",index=False)
 report={"sample_races":len(set(df.race_id)),"checks":len(df),"max_abs_error":maxerr,"passed":bool(maxerr<1e-10)}
 (out/"report.json").write_text(json.dumps(report,indent=2));print(json.dumps(report))
 if not report["passed"]:raise SystemExit("Market model parity failed")
if __name__=="__main__":main()
