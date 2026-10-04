"""Refresh immutable inference history, preserving every deployed model byte.
Runs only in the authorized model-publishing workflow. No model retraining.
"""
from pathlib import Path
import argparse, asyncio, hashlib, json, os, tarfile, urllib.request
from datetime import datetime,timedelta,timezone
import pandas as pd
from baken_academia import jra_backfill
from baken_academia.rein_history import build as profile_build


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def broker(body):
    token_req=urllib.request.Request(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=rein-supabase-model-v1',headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(token_req,timeout=30) as r:token=json.load(r)['value']
    req=urllib.request.Request(os.environ['SUPABASE_BROKER_URL'],data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)


def merge_history(base, fresh, start, end):
    fresh=fresh.copy();fresh['race_date']=pd.to_datetime(fresh.race_date)
    if fresh.duplicated(['race_id','horse_number']).any():raise ValueError('Duplicate fresh runners')
    if not fresh.race_date.between(pd.Timestamp(start),pd.Timestamp(end)).all():raise ValueError('Unexpected history date')
    if len(fresh) and fresh.horse_id.isna().any():raise ValueError('Missing horse identifiers')
    merged=pd.concat([base,fresh],ignore_index=True).drop_duplicates(['race_id','horse_number'],keep='last')
    merged['race_date']=pd.to_datetime(merged.race_date)
    return merged.sort_values(['race_date','race_id','horse_number']).reset_index(drop=True)


async def main():
    out=Path('artifacts/rein-history-refresh');out.mkdir(parents=True,exist_ok=True)
    active=broker({'action':'current'});model=active['model']
    now=datetime.now(timezone(timedelta(hours=9)));end=now.date()-timedelta(days=now.hour<22)
    start=pd.Timestamp(model['history_through']).date()+timedelta(days=1)
    summary={'previous_version':model['version'],'previous_history_through':model['history_through'],'checked_through':str(end),'models_retrained':False}
    if start>end:
        summary['status']='unchanged';(out/'summary.json').write_text(json.dumps(summary,indent=2));return
    if (end-start).days>45:raise ValueError('History gap exceeds bounded refresh window')
    with urllib.request.urlopen(active['bundle_url'],timeout=60) as r:bundle=r.read()
    if hashlib.sha256(bundle).hexdigest()!=model['artifact_sha256']:raise ValueError('Active bundle checksum mismatch')
    archive=out/'active.tar.gz';archive.write_bytes(bundle)
    extracted=out/'base';extracted.mkdir(exist_ok=True)
    with tarfile.open(archive,'r:gz') as t:t.extractall(extracted,filter='data')
    root=next(extracted.glob('*/schema.json')).parent
    old=json.loads((root/'manifest.json').read_text());frozen={p.relative_to(root).as_posix():digest(p) for p in root.rglob('*') if p.is_file() and (p.suffix=='.txt' or p.name=='schema.json')}
    result=await jra_backfill.backfill(argparse.Namespace(start_date=str(start),end_date=str(end),work_dir=out/'raw',output=out/'fresh.parquet',min_delay=3.0,max_delay=4.0,permission_confirmed=True,continue_on_error=False,allow_empty=True,max_events=None))
    if result.get('errors'):raise ValueError('Incomplete JRA history refresh')
    if not result.get('races'):
        summary.update(status='unchanged',source=result);(out/'summary.json').write_text(json.dumps(summary,indent=2));return
    base=pd.read_parquet(root/'data/history.parquet');fresh=pd.read_parquet(out/'fresh.parquet')
    merged=merge_history(base,fresh,start,end)
    required=set(base.columns)-set(fresh.columns)
    if required:raise ValueError('Fresh rows missing columns: '+','.join(sorted(required)))
    history=root/'data/history.parquet';merged.to_parquet(history,index=False,compression='zstd',compression_level=12)
    profile=root/'history-profile.json.gz';profile_build(history,profile)
    for name,sha in frozen.items():
        if digest(root/name)!=sha:raise ValueError('A model or schema changed during history refresh')
    key=digest(history)+''.join(frozen[name] for name in sorted(frozen))
    version='rein-role-v4-'+hashlib.sha256(key.encode()).hexdigest()[:40]
    newroot=root.with_name(version);root.rename(newroot);root=newroot
    manifest={**old,'version':version,'history_through':str(merged.race_date.max().date()),'history_rows':len(merged),'history_races':int(merged.race_id.nunique()),'source_commit':os.environ['GITHUB_SHA'],'created_at':datetime.now(timezone.utc).isoformat()}
    manifest['files']=[{'path':p.relative_to(root).as_posix(),'sha256':digest(p),'size_bytes':p.stat().st_size} for p in sorted(root.rglob('*')) if p.is_file() and p.name!='manifest.json']
    (root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    summary.update(status='refreshed',new_version=version,history_through=manifest['history_through'],added_rows=len(merged)-len(base),added_races=int(merged.race_id.nunique()-base.race_id.nunique()),profileSha=digest(root/'history-profile.json.gz'),frozen_model_files=frozen)
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    metrics={'comparison':{**model.get('metrics',{}),'historyRefresh':summary}}
    (out/'metrics.json').write_text(json.dumps(metrics,ensure_ascii=False))
    packed=out/f'{version}.bundle.tar.gz'
    with tarfile.open(packed,'w:gz') as t:t.add(root,arcname=version)
    paths={'MODEL_VERSION':version,'MODEL_BUNDLE':packed,'MODEL_MANIFEST':root/'manifest.json','MODEL_PROFILE':root/'history-profile.json.gz','MODEL_METRICS':out/'metrics.json'}
    with open(os.environ['GITHUB_ENV'],'a') as f:
        for k,v in paths.items():print(f'{k}={v}',file=f)
    with open(os.environ['GITHUB_OUTPUT'],'a') as f:print('changed=true',file=f)
    print(json.dumps(summary,ensure_ascii=False),flush=True)

if __name__=='__main__':asyncio.run(main())
