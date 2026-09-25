from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import pandas as pd
ROOT=Path(".real-odds-model")
ROLES=("first","second","third")
def load():
 parts=[]
 for role in ROLES:
  p=pd.read_parquet(ROOT/role/"predictions.parquet");p["race_id"]=p.race_id.astype(str)
  p=p[["race_id","horse_number","race_date","popularity","finish_numeric","real_odds_market","real_odds_without_people"]].rename(columns={"real_odds_market":f"{role}_market","real_odds_without_people":f"{role}_rein"})
  parts.append(p)
 x=parts[0]
 for p in parts[1:]:x=x.merge(p.drop(columns=["race_date","popularity","finish_numeric"]),on=["race_id","horse_number"],validate="one_to_one")
 x["race_date"]=pd.to_datetime(x.race_date)
 x["market"]=.5*x.first_market+.3*x.second_market+.2*x.third_market
 x["rein"]=.5*x.first_rein+.3*x.second_rein+.2*x.third_rein
 x["current"]=.7*x.market+.3*x.rein
 x["edge"]=.5*np.log((x.first_rein+1e-12)/(x.first_market+1e-12))+.3*np.log((x.second_rein+1e-12)/(x.second_market+1e-12))+.2*np.log((x.third_rein+1e-12)/(x.third_market+1e-12))
 x["edge_score"]=x.market*np.exp(.75*x.edge)
 return x
def ranks(x,score):
 q=x.sort_values(["race_id",score,"popularity","horse_number"],ascending=[True,False,True,True]).copy();q["rank"]=q.groupby("race_id",observed=True).cumcount()+1;return q
def main():
 x=load();configs={}
 # Conservative hybrid: edge score only promotes within current Top N, preserving current tail.
 for n in (2,3,4):
  for gap in (0.,.1,.2,.3,.5,.75,1.):
   name=f"top{n}_edge_gap{gap}"
   vals=[]
   for rid,g in x.groupby("race_id",observed=True,sort=False):
    base=g.sort_values(["current","popularity","horse_number"],ascending=[False,True,True]).copy()
    head=base.head(n).copy();tail=base.iloc[n:].copy()
    head["_s"]=head.edge_score*np.where(head.edge>=gap,1.0,0.0)+head.current*np.where(head.edge<gap,1.0,0.0)
    head=head.sort_values(["_s","current","popularity"],ascending=[False,False,True])
    order=pd.concat([head,tail],ignore_index=False);vals.extend([(i,len(order)-j) for j,i in enumerate(order.index)])
   s=pd.Series(dict(vals));x[name]=x.index.map(s).astype(float);configs[name]={"top_n":n,"edge_gap":gap}
 # Rank-bonus hybrid: current base plus bounded bonus only when edge is positive/strong.
 for bonus in (.02,.05,.1,.15,.2):
  for threshold in (0.,.1,.2,.3,.5):
   name=f"bonus_{bonus}_thr_{threshold}";x[name]=x.current*(1+bonus*np.clip(x.edge-threshold,0,None));configs[name]={"bonus":bonus,"threshold":threshold}
 periods={"h1":("2025-01-01","2025-06-30"),"h2":("2025-07-01","2025-12-31"),"audit":("2026-01-01","2026-12-31")}
 rows=[]
 for name in ["current","edge_score"]+list(configs):
  q=ranks(x,name);actual=q.loc[q.finish_numeric.eq(1),["race_id","race_date","rank"]]
  for p,(lo,hi) in periods.items():
   a=actual.loc[actual.race_date.between(lo,hi)]
   rows.append({"candidate":name,"period":p,"races":len(a),**{f"top{k}":int(a["rank"].le(k).sum()) for k in range(1,6)}})
 grid=pd.DataFrame(rows)
 # Choose on H1: maximize Top5, then Top3, Top1. Must not be worse than current H1 Top5.
 h1=grid[grid.period.eq("h1")];base=h1[h1.candidate.eq("current")].iloc[0]
 eligible=h1[h1.top5.ge(base.top5)]
 chosen=eligible.sort_values(["top5","top3","top1","candidate"],ascending=[False,False,False,True]).iloc[0].candidate
 report={"selected":chosen,"definition":configs.get(chosen,chosen),"selection_rule":"H1 Top5 >= current; maximize Top5 then Top3 then Top1","production_changed":False,"periods":{}}
 for p in periods:
  report["periods"][p]={}
  for name in ("current","edge_score",chosen):
   r=grid[(grid.period.eq(p))&(grid.candidate.eq(name))].iloc[0]
   report["periods"][p][name]={f"top{k}":{"hits":int(r[f"top{k}"]),"races":int(r.races),"rate":float(r[f"top{k}"]/r.races)} for k in range(1,6)}
 out=Path("reports/rein-overall-hybrid");out.mkdir(parents=True,exist_ok=True);grid.to_csv(out/"grid.csv",index=False);(out/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
if __name__=="__main__":main()
