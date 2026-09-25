from pathlib import Path
import json,numpy as np,pandas as pd
R=Path(".real-odds-model")
ps=[]
for z in ("first","second","third"):
 p=pd.read_parquet(R/z/"predictions.parquet");p["race_id"]=p.race_id.astype(str)
 ps.append(p[["race_id","horse_number","race_date","popularity","finish_numeric","real_odds_market","real_odds_without_people"]].rename(columns={"real_odds_market":z+"_m","real_odds_without_people":z+"_r"}))
x=ps[0]
for p in ps[1:]:x=x.merge(p.drop(columns=["race_date","popularity","finish_numeric"]),on=["race_id","horse_number"])
x["race_date"]=pd.to_datetime(x.race_date);x["market"]=.5*x.first_m+.3*x.second_m+.2*x.third_m;x["rein"]=.5*x.first_r+.3*x.second_r+.2*x.third_r;x["current"]=.7*x.market+.3*x.rein
x["edge"]=.5*np.log((x.first_r+1e-12)/(x.first_m+1e-12))+.3*np.log((x.second_r+1e-12)/(x.second_m+1e-12))+.2*np.log((x.third_r+1e-12)/(x.third_m+1e-12));x["edge_score"]=x.market*np.exp(.75*x.edge)
e=x.sort_values(["race_id","edge_score","popularity","horse_number"],ascending=[1,0,1,1]).copy();e["rk"]=e.groupby("race_id").cumcount()+1
top=set(e.index[e.rk<=4]);races=x[["race_id","race_date"]].drop_duplicates("race_id").sort_values("race_id").reset_index(drop=True);mp={r:i for i,r in enumerate(races.race_id)}
base=np.zeros(len(races),bool)
for r in x.loc[x.index.isin(top)&x.finish_numeric.eq(1),"race_id"]:base[mp[r]]=1
p=x.loc[~x.index.isin(top)].copy();p["c"]=p.race_id.map(mp);p=p.sort_values(["c","horse_number"]).reset_index(drop=True)
codes=p.c.to_numpy();st=np.r_[0,1+np.flatnonzero(codes[1:]!=codes[:-1])];uc=codes[st]
F=p[["current","edge_score","second_r","third_r"]].to_numpy(float);cur=p.current.to_numpy(float);pop=p.popularity.fillna(9999).to_numpy(float);win=p.finish_numeric.eq(1).to_numpy()
cfg=[]
for wc in (0,.25,.5,.75,1):
 for we in (0,.1,.25,.5,.75,1):
  for w2,w3 in ((0,0),(.25,.25),(.25,.5),(.5,.5),(.5,1),(1,1)):
   if wc+we+w2+w3:cfg.append((f"c{wc}_e{we}_s{w2}_t{w3}",wc,we,w2,w3))
W=np.array([q[1:] for q in cfg]);S=F@W.T;mx=np.maximum.reduceat(S,st,axis=0);m=S==mx[codes]
cm=np.maximum.reduceat(np.where(m,cur[:,None],-np.inf),st,axis=0);m&=cur[:,None]==cm[codes]
pmx=np.maximum.reduceat(np.where(m,-pop[:,None],-np.inf),st,axis=0);m&=(-pop[:,None])==pmx[codes]
fh=np.maximum.reduceat((m&win[:,None]).astype(np.int8),st,axis=0).astype(bool)
hit=np.repeat(base[:,None],len(cfg),1);hit[uc]|=fh
dates=races.race_date.to_numpy(dtype="datetime64[D]");P={"h1":("2025-01-01","2025-06-30"),"h2":("2025-07-01","2025-12-31"),"audit":("2026-01-01","2026-12-31")}
rows=[]
for n,(a,b) in P.items():
 q=(dates>=np.datetime64(a))&(dates<=np.datetime64(b));cnt=hit[q].sum(0)
 for i,c in enumerate(cfg):rows.append({"candidate":c[0],"period":n,"races":int(q.sum()),"hits":int(cnt[i]),"rate":float(cnt[i]/q.sum())})
g=pd.DataFrame(rows);sel=g[g.period.eq("h1")].sort_values(["hits","candidate"],ascending=[0,1]).iloc[0].candidate;k=[c[0] for c in cfg].index(sel)
def bline(col):
 z=p.sort_values(["race_id",col,"current","popularity"],ascending=[1,0,0,1]).drop_duplicates("race_id");h=base.copy()
 for _,r in z[z.finish_numeric.eq(1)].iterrows():h[mp[r.race_id]]=1
 return h
b1,b2=bline("edge_score"),bline("current");rep={"selected":sel,"weights":cfg[k][1:],"selection":"2025H1 only; edge Top4 frozen; fifth boundary optimized","production_changed":False,"periods":{}}
for n,(a,b) in P.items():
 q=(dates>=np.datetime64(a))&(dates<=np.datetime64(b));rep["periods"][n]={}
 for nm,h in (("selected",hit[:,k]),("edge5",b1),("current_boundary",b2)):rep["periods"][n][nm]={"hits":int(h[q].sum()),"races":int(q.sum()),"rate":float(h[q].mean())}
o=Path("reports/rein-fifth-boundary-fast");o.mkdir(parents=True,exist_ok=True);g.to_csv(o/"grid.csv",index=False);(o/"report.json").write_text(json.dumps(rep,ensure_ascii=False,indent=2));print(json.dumps(rep,ensure_ascii=False))
