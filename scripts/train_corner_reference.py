"""Small, auditable pre-race corner model; no odds or current-race outcomes in inputs.

Train: through 2024. Check: 2025; audit: 2026. Fixed Ridge(alpha=20), no search.
The UI uses the same raw past passing sequences (latest first). Lateral placement
and length gaps are deliberately not prediction targets. Outputs are positions.
"""
from __future__ import annotations
import argparse
from collections import defaultdict, deque, Counter
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

FEATURES = ["last", "weighted", "spread", "samples", "early", "late", "gain", "field", "distance", "dirt", "gate"]

def position(seq, stage):
    if stage == 0:
        return seq[0] if seq else None
    index = stage - (5 - len(seq))
    return seq[index] if 2 <= len(seq) <= 4 and 0 <= index < len(seq) else None

def features(history, stage, field, distance, dirt, gate):
    values = [(position(seq, stage), 5-i) for i, seq in enumerate(history[:5])]
    values = [(v,w) for v,w in values if v is not None]
    if not values:
        return None
    vals = [v for v,_ in values]
    avg = sum(v*w for v,w in values) / sum(w for _,w in values)
    early = np.mean([s[0] for s in history])
    late = np.mean([s[-1] for s in history])
    return [vals[0]/field, avg/field, float(np.std(vals))/field, len(vals)/5,
            early/field, late/field, (late-early)/field, field/18,
            distance/2000, float(dirt), gate/8]

def layout_key(row):
    detail = str(row.course_detail)
    layout = "直線" if "直線" in detail else "外" if "外" in detail else "内" if "内" in detail else "標準"
    return f"{row.racecourse}|{row.surface}|{row.distance_m}|{layout}"

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--history", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--report", required=True)
    a=p.parse_args()
    x=pd.read_parquet(a.history)
    x=x[x.surface.isin(["芝","ダート"]) & ~x.finish_status.fillna("").str.contains("取消|除外")].copy()
    x=x.sort_values(["race_date","race_id","horse_number"])
    x["field"]=x.groupby("race_id").horse_id.transform("size")
    x["seq"]=x.corner_positions.map(lambda s:[int(v) for v in json.loads(s) if str(v).isdigit()])
    # Course-stage metadata is learned from training races, never future outcomes.
    course_counts=defaultdict(Counter)
    for _, race in x[x.race_date < "2025-01-01"].groupby("race_id", sort=False):
        r=next(race.itertuples())
        n=Counter(map(len,race.seq)).most_common(1)[0][0]
        if n in (0,2,3,4): course_counts[layout_key(r)][n]+=1
    courses={}
    for k,v in course_counts.items():
        n,c=v.most_common(1)[0]
        if c>=10 and c/sum(v.values())>=.9:
            courses[k]=list(range(5-n,5)) if n else []
    history=defaultdict(lambda:deque(maxlen=5))
    rows={s:[] for s in range(5)}
    for r in x.itertuples():
        past=list(history[r.horse_id])
        seq=r.seq
        if len(seq) in (2,3,4) and all(1<=v<=r.field for v in seq):
            for stage in range(5):
                y=position(seq,stage)
                f=features(past,stage,r.field,r.distance_m,r.surface=="ダート",r.gate) if past else None
                if y is not None and f is not None:
                    rows[stage].append([str(r.race_date.date()),r.race_id,r.field,y,f[1]*r.field,*f])
            history[r.horse_id].appendleft(seq)
    models={}
    report={"protocol":"Fixed Ridge alpha=20, train <=2024; 2025 check; 2026 audit. Pre-race history only. No odds/popularity. Reference only.","data_through":str(x.race_date.max().date()),"stages":{}}
    for stage,data in rows.items():
        d=pd.DataFrame(data,columns=["date","race","n","y","baseline",*FEATURES])
        train=d.date<"2025-01-01"
        fit=Ridge(alpha=20).fit(d.loc[train,FEATURES],d.loc[train,"y"]/d.loc[train,"n"])
        pred=np.clip(fit.predict(d[FEATURES])*d.n,1,d.n)
        d["prediction"]=pred
        metrics={}
        for name,mask in [("2025",d.date.between("2025-01-01","2025-12-31")),("2026",d.date>="2026-01-01")]:
            z=d[mask]
            error=np.abs(z.prediction-z.y)
            base=np.abs(np.clip(z.baseline,1,z.n)-z.y)
            metrics[name]={"runners":int(len(z)),"races":int(z.race.nunique()),"mae":float(error.mean()),"baseline_mae":float(base.mean()),"within_3":float((error<=3).mean()),"q80_error":float(error.quantile(.8))}
        # Never claim a validation improvement unless both periods support it.
        approved=all(m["mae"]<m["baseline_mae"] for m in metrics.values())
        models[str(stage)]={"coef":fit.coef_.tolist(),"intercept":float(fit.intercept_),"referenceApproved":approved,"checkError":metrics["2025"]["q80_error"],"auditMae":metrics["2026"]["mae"],"trainingRows":int(train.sum())}
        report["stages"][str(stage)]={"trainingRows":int(train.sum()),"approved":approved,**metrics}
    result={"version":"corner-ridge-v1","trainedThrough":"2024-12-31","features":FEATURES,"models":models,"courses":courses}
    Path(a.output).parent.mkdir(parents=True,exist_ok=True)
    Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
    Path(a.report).parent.mkdir(parents=True,exist_ok=True)
    Path(a.report).write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=="__main__": main()
