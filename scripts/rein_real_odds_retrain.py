"""JRA research-only retraining. Real final odds, no production activation.
Download only through the dedicated authenticated, read-only odds export.
2019-2024 train, 2025H1 select, 2025H2 confirm, 2026 retrospective audit.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import numpy as np
import pandas as pd

SEED = 20260925
ROLES = {'first': 1, 'second': 2, 'third': 3}
READER = 'https://dcewdzagnomcnvteokwj.supabase.co/functions/v1/rein-jra-odds-research-read'
AUDIENCE = 'rein-jra-odds-retrain-20260925'


def log(message):
    print(time.strftime('%H:%M:%S'), message, flush=True)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def fetch_odds(destination):
    """Bounded sequential export; never log credentials, source data or URLs with tokens."""
    token = None
    refreshed = 0.0
    def post(payload):
        nonlocal token, refreshed
        for attempt in range(3):
            try:
                if token is None or time.time() - refreshed > 150:
                    url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=' + AUDIENCE
                    request = Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
                    with urlopen(request, timeout=30) as response:
                        token = json.load(response)['value']
                    refreshed = time.time()
                request = Request(READER, data=json.dumps(payload).encode(), method='POST', headers={
                    'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with urlopen(request, timeout=40) as response:
                    return json.load(response)
            except HTTPError as exc:
                if exc.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                    raise RuntimeError(f'Authenticated odds reader failed: HTTP {exc.code}') from None
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise RuntimeError('Odds reader transport failure') from None
            time.sleep(2 ** attempt)
        raise RuntimeError('Odds download failed')
    metadata = post({'action': 'metadata'})
    expected = int(metadata['rows'])
    if not 300000 <= expected <= 500000:
        raise ValueError('Unexpected odds snapshot size')
    rows = []
    cursor = None
    for page in range(510):
        data = post({'action': 'page', 'cursor': cursor})
        batch = data['rows']
        rows.extend(batch)
        next_cursor = data['next_cursor']
        if next_cursor is None:
            break
        if next_cursor == cursor or not batch:
            raise RuntimeError('Odds cursor did not advance')
        cursor = next_cursor
        if (page + 1) % 50 == 0:
            log(f'Authenticated odds rows read: {len(rows)}/{expected}')
        time.sleep(.08)
    else:
        raise RuntimeError('Odds paging limit reached')
    odds = pd.DataFrame(rows)
    if len(odds) != expected or odds.duplicated(['race_id', 'horse_number']).any():
        raise RuntimeError('Odds export count or uniqueness check failed')
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    odds.to_parquet(destination, index=False)
    write_json(str(destination) + '.manifest.json', {
        'rows': len(odds), 'sha256': hashlib.sha256(Path(destination).read_bytes()).hexdigest(),
        'source': 'private.jra_win_place_odds', 'period': '2019-01-01..2026-09-13',
        'snapshot': 'historical final odds; not timestamped pre-race odds'})
    log(f'ODDS_EXPORT_COMPLETE rows={len(odds)}')


def odds_features(meta, odds):
    """Return only explicit market inputs; never outcome or payout columns."""
    joined = meta[['race_id', 'horse_number', 'race_date']].merge(
        odds, on=['race_id', 'horse_number'], how='left', validate='one_to_one', suffixes=('', '_odds'))
    d1 = pd.to_datetime(joined['race_date'], errors='coerce')
    d2 = pd.to_datetime(joined['race_date_odds'], errors='coerce')
    values = joined[['win_odds', 'place_odds_min', 'place_odds_max']].apply(pd.to_numeric, errors='coerce')
    valid = np.isfinite(values).all(axis=1) & values.ge(1).all(axis=1)
    valid &= values.place_odds_min.le(values.place_odds_max) & d1.eq(d2)
    valid &= values.le(100000).all(axis=1)
    complete = valid.groupby(meta.race_id, observed=True).transform('all')
    win = values.win_odds
    low, high = values.place_odds_min, values.place_odds_max
    f = pd.DataFrame(index=meta.index)
    f['odds_log_win'] = np.log(win)
    f['odds_win_share'] = (1 / win) / (1 / win).groupby(meta.race_id, observed=True).transform('sum')
    f['odds_favorite_share'] = f.odds_win_share.groupby(meta.race_id, observed=True).transform('max')
    f['odds_entropy'] = (-f.odds_win_share * np.log(f.odds_win_share)).groupby(meta.race_id, observed=True).transform('sum')
    f['odds_log_place_min'] = np.log(low)
    f['odds_log_place_max'] = np.log(high)
    f['odds_place_width'] = np.log(high / low)
    midpoint = np.sqrt(low * high)
    f['odds_place_share'] = (1 / midpoint) / (1 / midpoint).groupby(meta.race_id, observed=True).transform('sum')
    f['odds_place_win_ratio'] = np.log(f.odds_place_share / f.odds_win_share)
    return f, complete.to_numpy(), values


def prepare(bundle_root, odds_path, output):
    import rein_core as core
    from rein_blend_top5_audit import build_features, verify_parity
    from rein_market_edge_research import new_features, make_cohort, partition_features
    out = Path(output); out.mkdir(parents=True, exist_ok=True)
    root = Path(bundle_root)
    manifest = json.loads((root / 'manifest.json').read_text())
    for item in manifest['files']:
        if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Immutable bundle checksum mismatch')
    runtime = core.ReinRuntime.load(root, manifest['version'])
    raw = pd.read_parquet(root / 'data/history.parquet')
    x, base = build_features(raw, core)
    verify_parity(runtime, x, base, core, out)
    odds = pd.read_parquet(odds_path)
    odds['horse_number'] = pd.to_numeric(odds.horse_number, errors='raise').astype(int)
    coverage = {}
    for role, target in ROLES.items():
        features, _ = new_features(x, base, target)
        meta, features = make_cohort(x, features)
        market, families = partition_features(list(features))
        added, eligible, real_odds = odds_features(meta, odds)
        meta = meta.loc[eligible].reset_index(drop=True)
        features = pd.concat([features, added], axis=1).loc[eligible].reset_index(drop=True)
        for col in real_odds:
            meta[col] = real_odds.loc[eligible, col].to_numpy()
        if not np.isfinite(features.filter(like='odds_').to_numpy(float)).all():
            raise ValueError('Non-finite real odds features')
        counts = meta.groupby(meta.race_date.dt.year).race_id.nunique().to_dict()
        coverage[role] = {str(k): int(v) for k, v in counts.items()}
        if meta.loc[meta.race_date.lt('2025-01-01'), 'race_id'].nunique() < 18000:
            raise ValueError('Insufficient complete-odds training races')
        meta.to_parquet(out / f'{role}_meta.parquet', index=False)
        features.to_parquet(out / f'{role}_features.parquet', index=False)
        write_json(out / f'{role}_features.json', {'columns': list(features), 'rank_market': market,
            'odds_market': list(added), 'families': families})
        log(f'{role}: real-odds feature matrix={features.shape}, yearly races={counts}')
    write_json(out / 'coverage.json', coverage)
    log('REAL_ODDS_DATASET_READY')


def score_predictions(meta, probability, target):
    p = np.maximum(np.asarray(probability, float), 1e-12)
    codes, _ = pd.factorize(meta.race_id, sort=False)
    p /= np.bincount(codes, weights=p)[codes]
    ranked = meta[['race_id', 'race_date', 'horse_number', 'popularity', 'finish_numeric']].copy()
    ranked['p'] = p
    ranked = ranked.sort_values(['race_id', 'p', 'popularity', 'horse_number'], ascending=[True, False, True, True], kind='stable')
    ranked['rank'] = ranked.groupby('race_id', observed=True).cumcount() + 1
    actual = ranked.loc[ranked.finish_numeric.eq(target)].sort_values(['race_date', 'race_id'])
    result = actual[['race_id', 'race_date']].reset_index(drop=True)
    for k in range(1, 6):
        result[f'top{k}'] = actual['rank'].le(k).to_numpy()
    result['log_loss'] = -np.log(actual.p.to_numpy())
    y = meta.finish_numeric.eq(target).to_numpy(float)
    brier = np.bincount(codes, weights=(p - y) ** 2)
    mapping = pd.Series(brier, index=pd.unique(meta.race_id))
    result['brier'] = result.race_id.map(mapping)
    return result, p


def summarize(race_metrics):
    masks = {'selection_2025H1': race_metrics.race_date.lt('2025-07-01'),
             'confirmation_2025H2': race_metrics.race_date.between('2025-07-01', '2025-12-31'),
             'audit_2026': race_metrics.race_date.ge('2026-01-01')}
    results = {}
    for period, mask in masks.items():
        r = race_metrics.loc[mask]
        if r.empty:
            raise ValueError('An evaluation period is empty')
        results[period] = {'races': len(r), 'log_loss': float(r.log_loss.mean()), 'brier': float(r.brier.mean()),
            **{f'top{k}_hits': int(r[f'top{k}'].sum()) for k in range(1, 6)}}
    return results


def train(data_dir, role, output):
    import lightgbm as lgb
    root = Path(data_dir); out = Path(output); out.mkdir(parents=True, exist_ok=True)
    meta = pd.read_parquet(root / f'{role}_meta.parquet')
    frame = pd.read_parquet(root / f'{role}_features.parquet')
    info = json.loads((root / f'{role}_features.json').read_text())
    train_mask = meta.race_date.lt('2025-01-01')
    ev = ~train_mask
    for col in frame.select_dtypes('category'):
        categories = frame.loc[train_mask, col].dropna().unique().tolist()
        frame[col] = pd.Categorical(frame[col], categories=categories)
    target = ROLES[role]
    y = meta.finish_numeric.eq(target).astype(int)
    e = meta.loc[ev].reset_index(drop=True)
    market = info['rank_market'] + info['odds_market']
    nonpeople = [c for c in frame if c not in info['families']['people']]
    configs = {
        'rank_only': info['rank_market'],
        'real_odds_market': market,
        'real_odds_plus_all': list(frame),
        'real_odds_without_people': nonpeople,
        'real_odds_plus_recent': market + info['families']['recent_form'],
        'real_odds_plus_conditions': market + info['families']['condition_fit'],
        'real_odds_plus_pace': market + info['families']['pace']}
    params = dict(n_estimators=240, num_leaves=15, learning_rate=.03, min_child_samples=400,
        reg_lambda=15, feature_fraction=.85, n_jobs=2, verbosity=-1, random_state=SEED, max_bin=127)
    write_json(out / 'protocol.json', {'role': role, 'training': '2019..2024',
        'selection': '2025H1', 'confirmation': '2025H2', 'audit': '2026 retrospective, previously inspected',
        'primary': 'Top5 exact-finisher capture; Top3 then Top1 tie-breaks',
        'secondary': 'log loss, Brier score', 'models': configs, 'parameters': params,
        'production_change': False, 'actual_odds_used': True})
    predictions = e[['race_id', 'race_date', 'horse_number', 'popularity', 'finish_numeric']].copy()
    metrics = {}; selections = {}; per_race = []
    log(f'TRAINING_STARTED role={role} training_rows={int(train_mask.sum())} training_races={meta.loc[train_mask,"race_id"].nunique()}')
    for name, columns in configs.items():
        model = lgb.LGBMClassifier(**params)
        started = time.monotonic()
        model.fit(frame.loc[train_mask, columns], y.loc[train_mask])
        probability = model.predict_proba(frame.loc[ev, columns], num_threads=2)[:, 1]
        if not np.isfinite(probability).all():
            raise RuntimeError('Invalid model output')
        r, p = score_predictions(e, probability, target)
        predictions[name] = p
        per_race.append(r.assign(model=name))
        metrics[name] = summarize(r)
        model.booster_.save_model(str(out / f'{name}.txt'))
        selections[name] = metrics[name]['selection_2025H1']
        log(f'MODEL_TRAINED role={role} model={name} features={len(columns)} seconds={time.monotonic()-started:.1f}')
    winner = max(configs, key=lambda n: (selections[n]['top5_hits'], selections[n]['top3_hits'], selections[n]['top1_hits'], n == 'real_odds_market'))
    probability_winner = min(configs, key=lambda n: selections[n]['log_loss'])
    write_json(out / 'selection.json', {'top5': winner, 'probability': probability_winner,
        'selected_from': '2025H1 only', 'automatic_activation': False})
    odds_rank, _ = score_predictions(e, 1 / e.win_odds.to_numpy(float), target)
    metrics['raw_win_odds'] = summarize(odds_rank)
    per_race.append(odds_rank.assign(model='raw_win_odds'))
    predictions.to_parquet(out / 'predictions.parquet', index=False)
    pd.concat(per_race).to_csv(out / 'per_race_metrics.csv.gz', index=False, compression='gzip')
    write_json(out / 'report.json', {'role': role, 'target_finish': target, 'selected_top5': winner,
        'selected_probability': probability_winner, 'metrics': metrics,
        'source_commit': os.environ.get('GITHUB_SHA'), 'production_changed': False,
        'limitations': ['Historical final odds; not live 10-minute odds', '2026 is reused retrospective audit',
            'Real odds availability restricts cohort; compare only identical races',
            'No profitability, deployment or superiority claim from training completion']})
    log(f'TRAINING_COMPLETE role={role} models={len(configs)} selected_top5={winner}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['fetch', 'prepare', 'train'])
    parser.add_argument('--output', required=True)
    parser.add_argument('--odds')
    parser.add_argument('--bundle-root')
    parser.add_argument('--data-dir')
    parser.add_argument('--role', choices=list(ROLES))
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'rein-web/api'))
    if args.mode == 'fetch': fetch_odds(args.output)
    elif args.mode == 'prepare': prepare(args.bundle_root, args.odds, args.output)
    else: train(args.data_dir, args.role, args.output)

if __name__ == '__main__':
    main()
