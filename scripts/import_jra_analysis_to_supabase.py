from __future__ import annotations
import json, os, time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import pandas as pd

IMPORT_URL="https://dcewdzagnomcnvteokwj.supabase.co/functions/v1/github-jra-analysis-import"
TOKEN_URL=os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]+"&audience=rein-jra-supabase-import-v1"
TOKEN_HEADER=os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
_token=None
_token_at=0.0

COURSE_CODE={"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京","06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"}

def token():
    global _token,_token_at
    now=time.time()
    if _token and now-_token_at<240:return _token
    req=Request(TOKEN_URL,headers={"Authorization":"Bearer "+TOKEN_HEADER})
    with urlopen(req,timeout=30) as r:
        _token=json.load(r)["value"]
    _token_at=now
    return _token

def post(kind,rows,attempt=1):
    """Idempotent batch upsert with bounded retry and fault isolation."""
    global _token, _token_at
    data=json.dumps({"kind":kind,"rows":rows},ensure_ascii=False,default=str).encode()
    req=Request(IMPORT_URL,data=data,headers={"Authorization":"Bearer "+token(),"Content-Type":"application/json"},method="POST")
    try:
        with urlopen(req,timeout=90) as r:
            out=json.load(r)
        if not out.get("ok"):raise RuntimeError(out)
        return
    except HTTPError as e:
        detail=e.read().decode("utf-8",errors="replace")[:4000]
        status=e.code
        if status==401:
            _token=None; _token_at=0.0
        retryable=status in (401,408,409,425,429,500,502,503,504)
        if retryable and attempt<=4:
            delay=min(20,2**attempt)
            print(f"retry {kind} rows={len(rows)} status={status} attempt={attempt} detail={detail}",flush=True)
            time.sleep(delay)
            return post(kind,rows,attempt+1)
        if status>=500 and len(rows)>25:
            middle=len(rows)//2
            print(f"split {kind} rows={len(rows)} after status={status} detail={detail}",flush=True)
            post(kind,rows[:middle])
            post(kind,rows[middle:])
            return
        identity=[{k:r.get(k) for k in ("race_id","horse_id","horse_number","bet_type","selection_key") if k in r} for r in rows[:3]]
        raise RuntimeError(f"{kind} import failed status={status} rows={len(rows)} identity={identity} detail={detail}") from e
    except (URLError,TimeoutError) as e:
        if attempt<=4:
            delay=min(20,2**attempt)
            print(f"retry {kind} rows={len(rows)} transport={e} attempt={attempt}",flush=True)
            time.sleep(delay)
            return post(kind,rows,attempt+1)
        if len(rows)>25:
            middle=len(rows)//2
            post(kind,rows[:middle])
            post(kind,rows[middle:])
            return
        raise

def batches(rows,n=400):
    for i in range(0,len(rows),n):yield rows[i:i+n]

def clean(v):
    if pd.isna(v):return None
    if hasattr(v,"item"):v=v.item()
    if isinstance(v,pd.Timestamp):return v.date().isoformat()
    return v

def import_runners():
    df=pd.read_parquet("data/raw/jra/races-2019-2026.parquet")
    cols=["race_id","race_date","racecourse","race_no","race_name","race_class","surface","distance_m","course_detail","going","weather","horse_id","horse_number","gate","horse_name","blinkers","breeder_name","breeder_source_cname","finish_position","finish_status","popularity","horse_weight","horse_weight_change","weight_carried","jockey_id","jockey_name","trainer_id","trainer_name","avg_1f","source_cname"]
    rows=[{c:clean(row.get(c)) for c in cols} for row in df.to_dict("records")]
    for i,b in enumerate(batches(rows),1):
        post("runners",b)
        if i%25==0:print("runners",min(i*400,len(rows)),"/",len(rows),flush=True)

def import_odds():
    files=sorted(Path(".odds-normalized/win-place").glob("*.parquet"))
    all_rows=[]
    for p in files:
        df=pd.read_parquet(p)
        if df.empty:continue
        df["race_date"]=pd.to_datetime(df["race_date"])
        df["racecourse"]=df["course_code"].astype(str).str.zfill(2).map(COURSE_CODE)
        df=df.loc[df["racecourse"].notna()].copy()
        df["race_id"]=df["race_date"].dt.strftime("%Y%m%d")+"-"+df["racecourse"]+"-"+df["race_no"].astype(int).astype(str).str.zfill(2)
        for row in df.to_dict("records"):
            all_rows.append({
                "race_id":str(row["race_id"]),"race_date":clean(row["race_date"]),"racecourse":row["racecourse"],
                "race_no":int(row["race_no"]),"horse_number":int(row["horse_number"]),
                "win_odds":clean(row.get("win_odds")),"place_odds_min":clean(row.get("place_odds_min")),
                "place_odds_max":clean(row.get("place_odds_max")),"source_cname":row.get("source_cname"),
            })
    dedup={(r["race_id"],r["horse_number"]):r for r in all_rows}
    rows=list(dedup.values())
    for i,b in enumerate(batches(rows),1):
        post("odds",b)
        if i%25==0:print("odds",min(i*400,len(rows)),"/",len(rows),flush=True)

def selection_key(row):
    vals=[row.get("selection_1"),row.get("selection_2"),row.get("selection_3")]
    vals=[str(int(v)) for v in vals if pd.notna(v)]
    return "-".join(vals)

def import_payouts():
    files=sorted(Path(".odds-normalized/payouts").glob("*.parquet"))
    rows=[]
    for p in files:
        df=pd.read_parquet(p)
        for row in df.to_dict("records"):
            key=selection_key(row)
            if not key:continue
            rows.append({
                "race_id":str(row["race_id"]),"race_date":clean(pd.to_datetime(row["race_date"])),
                "race_no":int(row["race_no"]),"bet_type":str(row["bet_type"]),
                "selection_key":key,"selection_1":clean(row.get("selection_1")),
                "selection_2":clean(row.get("selection_2")),"selection_3":clean(row.get("selection_3")),
                "payout_yen_per_100":int(row["payout_yen_per_100"]),"source_cname":row.get("source_cname"),
            })
    dedup={(r["race_id"],r["bet_type"],r["selection_key"]):r for r in rows}
    rows=list(dedup.values())
    for i,b in enumerate(batches(rows),1):
        post("payouts",b)
        if i%25==0:print("payouts",min(i*400,len(rows)),"/",len(rows),flush=True)

def main():
    import_runners()
    import_odds()
    import_payouts()
    print("JRA Supabase analysis import complete",flush=True)

if __name__=="__main__":main()
