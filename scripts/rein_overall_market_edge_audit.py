from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import pandas as pd

ROOT=Path(".real-odds-model")
ROLES=("first","second","third")
WEIGHTS=[i/20 for i in range(21)]

def load():
 parts=[]
 for role in ROLES:
  p=pd.read_parquet(ROOT/role/"predictions.parquet")
  p["race_id"]=p.race_id.astype(str)
  cols=["race_id","horse_number","race_date","popularity","finish_numeric","real_odds_market","real_odds_without_people"]
  p=p[cols].rename(columns={"real_odds_market":f"{role}_market","real_odds_without_people":f"{role}_rein"})
  parts.append(p)
 x=parts[0]
 for p in parts[1:]:
  x=x.merge(p.drop(columns=["race_date","popularity","finish_numeric"]),on=["race_id","horse_number"],validate="one_to_one")
 x["race_date"]=pd.to_datetime(x.race_date)
 return x

def race_rank_hit(x,score,k=5):
 q=x.sort_values(["race_id",score,"popularity","horse_number"],ascending=[True,False,True,True])
 q["rank"]=q.groupby("race_id",observed=True).cumcount()+1
 a=q.loc[q.finish_numeric.eq(1)]
 return a.set_index("race_id")["rank"].le(k)

def main():
 x=load()
 # Market composite and REIN composite use the same 50/30/20 role structure as current overall.
 x["market_composite"]=.5*x.first_market+.3*x.second_market+.2*x.third_market
 x["rein_composite"]=.5*x.first_rein+.3*x.second_rein+.2*x.third_rein
 # Explicit disagreement features. Positive means REIN raises the horse above its market-role score.
 for role in ROLES:x[f"{role}_edge"]=np.log((x[f"{role}_rein"]+1e-12)/(x[f"{role}_market"]+1e-12))
 # Search is predeclared and selected only on 2025H1.
 candidates={}
 for w in WEIGHTS:
  name=f"blend_{int(w*100):03d}"
  x[name]=(1-w)*x.market_composite+w*x.rein_composite
  candidates[name]={"kind":"blend","w":w}
 # Edge-aware score: market anchor times exp(weighted role disagreement).
 for scale in [0,.1,.2,.3,.4,.5,.75,1.0]:
  for w1,w2,w3 in [(1,0,0),(.5,.3,.2),(.4,.3,.3),(.3,.3,.4),(.2,.3,.5),(.2,.2,.6)]:
   name=f"edge_{scale}_{w1}_{w2}_{w3}"
   edge=w1*x.first_edge+w2*x.second_edge+w3*x.third_edge
   x[name]=x.market_composite*np.exp(scale*edge)
   candidates[name]={"kind":"edge","scale":scale,"role_weights":[w1,w2,w3]}
 periods={"selection_2025H1":("2025-01-01","2025-06-30"),"confirmation_2025H2":("2025-07-01","2025-12-31"),"audit_2026":("2026-01-01","2026-12-31")}
 rows=[]
 for name in candidates:
  hit=race_rank_hit(x,name,5)
  for period,(lo,hi) in periods.items():
   ids=set(x.loc[x.race_date.between(lo,hi),"race_id"].unique())
   z=hit.loc[hit.index.isin(ids)]
   rows.append({"candidate":name,"period":period,"races":len(z),"top5_hits":int(z.sum()),"top5_rate":float(z.mean())})
 grid=pd.DataFrame(rows)
 sel=grid.loc[grid.period.eq("selection_2025H1")].sort_values(["top5_hits","candidate"],ascending=[False,True])
 winner=str(sel.iloc[0].candidate)
 # Tie-break among equal Top5 by Top3 then Top1, all on H1 only.
 tied=sel.loc[sel.top5_hits.eq(sel.iloc[0].top5_hits),"candidate"].tolist()
 for k in (3,1):
  vals=[]
  for name in tied:
   h=race_rank_hit(x,name,k);ids=set(x.loc[x.race_date.between("2025-01-01","2025-06-30"),"race_id"].unique());z=h.loc[h.index.isin(ids)]
   vals.append((int(z.sum()),name))
  best=max(v[0] for v in vals);tied=sorted([n for v,n in vals if v==best])
 winner=tied[0]
 # Baselines: raw final win odds/rank, market composite, current-style 70/30 market+REIN composite.
 x["raw_market"]=1/np.maximum(pd.to_numeric(x.popularity,errors="coerce"),1)
 x["current_70_30"]=.7*x.market_composite+.3*x.rein_composite
 baselines=["raw_market","market_composite","current_70_30"]
 report={"protocol":{"selection":"2025H1","confirmation":"2025H2","audit":"2026 retrospective","primary":"winner in overall Top5","candidates":len(candidates),"production_changed":False},"selected":winner,"definition":candidates[winner],"periods":{}}
 for period,(lo,hi) in periods.items():
  ids=set(x.loc[x.race_date.between(lo,hi),"race_id"].unique());report["periods"][period]={}
  for name in baselines+[winner]:
   out={}
   for k in range(1,6):
    h=race_rank_hit(x,name,k);z=h.loc[h.index.isin(ids)];out[f"top{k}"]={"hits":int(z.sum()),"races":len(z),"rate":float(z.mean())}
   report["periods"][period][name]=out
 out=Path("reports/rein-overall-market-edge");out.mkdir(parents=True,exist_ok=True)
 grid.to_csv(out/"grid.csv",index=False);(out/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps({"selected":winner,"definition":candidates[winner],"audit":report["periods"]["audit_2026"]},ensure_ascii=False))
if __name__=="__main__":main()
