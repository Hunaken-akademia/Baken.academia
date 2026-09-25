from __future__ import annotations
import json
from pathlib import Path
import numpy as np,pandas as pd
ROOT=Path(".real-odds-model")
def load():
 ps=[]
 for role in ("first","second","third"):
  p=pd.read_parquet(ROOT/role/"predictions.parquet");p["race_id"]=p.race_id.astype(str)
  p=p[["race_id","horse_number","race_date","popularity","finish_numeric","real_odds_market","real_odds_without_people"]].rename(columns={"real_odds_market":role+"_m","real_odds_without_people":role+"_r"});ps.append(p)
 x=ps[0]
 for p in ps[1:]:x=x.merge(p.drop(columns=["race_date","popularity","finish_numeric"]),on=["race_id","horse_number"],validate="one_to_one")
 x["race_date"]=pd.to_datetime(x.race_date);x["market"]=.5*x.first_m+.3*x.second_m+.2*x.third_m;x["rein"]=.5*x.first_r+.3*x.second_r+.2*x.third_r;x["current"]=.7*x.market+.3*x.rein
 x["edge"]=.5*np.log((x.first_r+1e-12)/(x.first_m+1e-12))+.3*np.log((x.second_r+1e-12)/(x.second_m+1e-12))+.2*np.log((x.third_r+1e-12)/(x.third_m+1e-12));x["edge_score"]=x.market*np.exp(.75*x.edge)
 return x
def evaluate(x,selector):
 rows=[]
 for rid,g in x.groupby("race_id",observed=True,sort=False):
  edge=g.sort_values(["edge_score","popularity","horse_number"],ascending=[False,True,True]);head=edge.head(4);pool=g.loc[~g.index.isin(head.index)]
  fifth=selector(pool);chosen=set(head.index)|{fifth};winner=g.index[g.finish_numeric.eq(1)]
  rows.append({"race_id":rid,"race_date":g.race_date.iloc[0],"hit":bool(len(winner) and winner[0] in chosen)})
 return pd.DataFrame(rows)
def main():
 x=load();configs={}
 # Boundary score candidates only decide the fifth horse after edge Top4 is frozen.
 for wc in (0,.25,.5,.75,1):
  for we in (0,.1,.25,.5,.75,1):
   for w2,w3 in ((0,0),(.25,.25),(.25,.5),(.5,.5),(.5,1),(1,1)):
    name=f"c{wc}_e{we}_s{w2}_t{w3}"
    configs[name]=(wc,we,w2,w3)
 periods={"h1":("2025-01-01","2025-06-30"),"h2":("2025-07-01","2025-12-31"),"audit":("2026-01-01","2026-12-31")}
 rows=[]
 for name,(wc,we,w2,w3) in configs.items():
  def pick(pool):
   z=pool.copy();z["_boundary"]=wc*z.current+we*z.edge_score+w2*z.second_r+w3*z.third_r
   return z.sort_values(["_boundary","current","popularity"],ascending=[False,False,True]).index[0]
  e=evaluate(x,pick)
  for p,(lo,hi) in periods.items():
   q=e[e.race_date.between(lo,hi)];rows.append({"candidate":name,"period":p,"races":len(q),"hits":int(q.hit.sum()),"rate":float(q.hit.mean())})
 grid=pd.DataFrame(rows);h1=grid[grid.period.eq("h1")];winner=h1.sort_values(["hits","candidate"],ascending=[False,True]).iloc[0].candidate
 # baselines: edge fifth and current fifth after frozen edge top4
 bases={}
 for label,col in (("edge5","edge_score"),("current_boundary","current")):
  e=evaluate(x,lambda p,c=col:p.sort_values([c,"popularity"],ascending=[False,True]).index[0]);bases[label]=e
 report={"selected":winner,"weights":configs[winner],"selection":"2025H1 only; edge Top4 frozen; choose fifth by max Top5 hits","production_changed":False,"periods":{}}
 selected=configs[winner]
 def sp(pool):
  wc,we,w2,w3=selected;z=pool.copy();z["_boundary"]=wc*z.current+we*z.edge_score+w2*z.second_r+w3*z.third_r;return z.sort_values(["_boundary","current","popularity"],ascending=[False,False,True]).index[0]
 se=evaluate(x,sp)
 for p,(lo,hi) in periods.items():
  report["periods"][p]={}
  for label,e in [("selected",se),*bases.items()]:
   q=e[e.race_date.between(lo,hi)];report["periods"][p][label]={"hits":int(q.hit.sum()),"races":len(q),"rate":float(q.hit.mean())}
 out=Path("reports/rein-fifth-boundary");out.mkdir(parents=True,exist_ok=True);grid.to_csv(out/"grid.csv",index=False);(out/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
if __name__=="__main__":main()
