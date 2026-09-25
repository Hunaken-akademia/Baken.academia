"""Offline retraining input adapter. Reads existing GitHub odds archives only.
No Supabase access, external authentication, database changes or deployment.
This stage uses REAL WIN ODDS ONLY; place odds are not fabricated or substituted.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path
import numpy as np
import pandas as pd
from rein_real_odds_retrain import log, write_json, ROLES


def load_saved_odds(directory):
    paths = sorted(Path(directory).rglob('*.tar.gz'))
    if len(paths) != 30:
        raise ValueError(f'Expected 25 historical + 5 recent odds archives, got {len(paths)}')
    frames = []; audit = []
    for path in paths:
        if not re.fullmatch(r'jra-final-odds-[0-9a-z-]+\.tar\.gz', path.name):
            raise ValueError('Unexpected archive name')
        with tarfile.open(path, 'r:gz') as archive:
            members = [m for m in archive.getmembers() if m.isfile() and m.name.endswith('.parquet')]
            if len(members) != 1 or members[0].size > 20_000_000:
                raise ValueError('Unexpected odds parquet member')
            payload = archive.extractfile(members[0]).read()
            metadata_members = [m for m in archive.getmembers() if m.isfile() and m.name.endswith('.audit.json')]
            if len(metadata_members) != 1:
                raise ValueError('Missing odds provenance audit')
            source_audit = json.load(archive.extractfile(metadata_members[0]))
            digest = hashlib.sha256(payload).hexdigest()
            if source_audit.get('sha256') != digest:
                raise ValueError(f'Odds parquet checksum mismatch in {path.name}')
            frame = pd.read_parquet(io.BytesIO(payload))
            required = ['race_id','horse_number','race_date','horse_id','win_odds']
            if not set(required).issubset(frame):
                raise ValueError('Missing actual win odds or runner identity')
            frames.append(frame[required])
            audit.append({'archive':path.name,'rows':len(frame),'sha256':digest})
    odds = pd.concat(frames, ignore_index=True)
    odds['horse_number'] = pd.to_numeric(odds.horse_number, errors='raise').astype(int)
    odds['win_odds'] = pd.to_numeric(odds.win_odds, errors='coerce')
    odds['race_date'] = pd.to_datetime(odds.race_date, errors='raise')
    odds['horse_id'] = odds.horse_id.astype(str).str.lstrip('0').replace('', '0')
    duplicates = odds.loc[odds.duplicated(['race_id','horse_number'], keep=False)]
    if not duplicates.empty:
        conflicts = duplicates.groupby(['race_id','horse_number'], observed=True).win_odds.nunique(dropna=False)
        if (conflicts > 1).any():
            raise ValueError('Conflicting final odds snapshots')
    odds = odds.drop_duplicates(['race_id','horse_number'])
    if len(odds) < 300000:
        raise ValueError('Insufficient archived real odds')
    return odds, audit


def win_market_features(meta, odds):
    join = meta[['race_id','horse_number','race_date','horse_id']].merge(
        odds, on=['race_id','horse_number'], how='left', validate='one_to_one', suffixes=('', '_odds'))
    win = pd.to_numeric(join.win_odds, errors='coerce')
    valid = np.isfinite(win) & win.between(1,100000)
    valid &= pd.to_datetime(join.race_date).eq(pd.to_datetime(join.race_date_odds))
    valid &= join.horse_id.astype(str).str.lstrip('0').eq(join.horse_id_odds.astype(str).str.lstrip('0'))
    complete = valid.groupby(meta.race_id, observed=True).transform('all')
    share = (1/win)/(1/win).groupby(meta.race_id,observed=True).transform('sum')
    f = pd.DataFrame(index=meta.index)
    f['odds_log_win'] = np.log(win)
    f['odds_win_share'] = share
    f['odds_favorite_share'] = share.groupby(meta.race_id,observed=True).transform('max')
    f['odds_entropy'] = (-share*np.log(share)).groupby(meta.race_id,observed=True).transform('sum')
    f['odds_concentration'] = share.pow(2).groupby(meta.race_id,observed=True).transform('sum')
    f['odds_relative_to_favorite'] = np.log(share/f.odds_favorite_share)
    f['odds_log_rank'] = np.log(win.groupby(meta.race_id,observed=True).rank(method='min'))
    return f, complete.to_numpy(), win.to_numpy()


def prepare(root, odds_dir, output):
    import rein_core as core
    from rein_blend_top5_audit import build_features, verify_parity
    from rein_market_edge_research import new_features, make_cohort, partition_features
    root = Path(root); out = Path(output); out.mkdir(parents=True,exist_ok=True)
    manifest = json.loads((root/'manifest.json').read_text())
    for item in manifest['files']:
        if hashlib.sha256((root/item['path']).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Immutable history/model checksum mismatch')
    odds, audit = load_saved_odds(odds_dir)
    write_json(out/'archive_audit.json',{'sources':audit,'odds_rows':len(odds),'market_input':'actual historical final win odds ONLY'})
    log(f'ARCHIVED_REAL_ODDS_READY rows={len(odds)} races={odds.race_id.nunique()} archives={len(audit)}')
    raw = pd.read_parquet(root/'data/history.parquet')
    runtime = core.ReinRuntime.load(root,manifest['version'])
    x, base = build_features(raw,core)
    verify_parity(runtime,x,base,core,out)
    coverage = {}
    for role,target in ROLES.items():
        f,_ = new_features(x,base,target)
        meta,f = make_cohort(x,f)
        market,families = partition_features(list(f))
        added,keep,win = win_market_features(meta,odds)
        before = meta.groupby(meta.race_date.dt.year).race_id.nunique()
        meta = meta.loc[keep].reset_index(drop=True)
        f = pd.concat([f,added],axis=1).loc[keep].reset_index(drop=True)
        meta['win_odds'] = win[keep]
        if not np.isfinite(f[list(added)].to_numpy(float)).all():
            raise ValueError('Invalid actual win-odds features')
        after = meta.groupby(meta.race_date.dt.year).race_id.nunique()
        train_races = meta.loc[meta.race_date.lt('2025-01-01'),'race_id'].nunique()
        if train_races < 18000 or meta.loc[meta.race_date.ge('2026-01-01'),'race_id'].nunique()<2000:
            raise ValueError('Archived odds coverage below minimum research cohort')
        meta.to_parquet(out/f'{role}_meta.parquet',index=False)
        f.to_parquet(out/f'{role}_features.parquet',index=False)
        write_json(out/f'{role}_features.json',{'columns':list(f),'rank_market':market,'odds_market':list(added),'families':families})
        coverage[role]={'eligible_before_odds':{str(k):int(v) for k,v in before.items()},
            'complete_real_win_odds':{str(k):int(v) for k,v in after.items()},'train_races':int(train_races)}
        log(f'PREPARED role={role} rows={len(meta)} training_races={train_races}')
    write_json(out/'coverage.json',coverage)
    log('REAL_WIN_ODDS_DATASET_READY')

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--bundle-root',required=True)
    parser.add_argument('--odds-dir',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'rein-web/api'))
    prepare(args.bundle_root,args.odds_dir,args.output)
