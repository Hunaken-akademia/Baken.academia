"""Vectorized reproduction of the original fifth-boundary audit; no deployment."""
from __future__ import annotations

import hashlib
import json
import os
import time
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('.real-odds-model')
OUT = Path('reports/rein-fifth-boundary')
PERIODS = {
    'h1': ('2025-01-01', '2025-06-30'),
    'h2': ('2025-07-01', '2025-12-31'),
    'audit': ('2026-01-01', '2026-12-31'),
}
CONFIGS = [
    (f'c{wc}_e{we}_s{w2}_t{w3}', (wc, we, w2, w3))
    for wc in (0, .25, .5, .75, 1)
    for we in (0, .1, .25, .5, .75, 1)
    for w2, w3 in ((0, 0), (.25, .25), (.25, .5), (.5, .5), (.5, 1), (1, 1))
]


def load() -> pd.DataFrame:
    parts = []
    for role in ('first', 'second', 'third'):
        p = pd.read_parquet(ROOT / role / 'predictions.parquet')
        p['race_id'] = p.race_id.astype(str)
        p = p[['race_id', 'horse_number', 'race_date', 'popularity',
               'finish_numeric', 'real_odds_market', 'real_odds_without_people']]
        if p.duplicated(['race_id', 'horse_number']).any():
            raise ValueError(f'Duplicate runners in {role}')
        parts.append(p.rename(columns={
            'real_odds_market': role + '_m',
            'real_odds_without_people': role + '_r',
        }))
    x = parts[0]
    for p in parts[1:]:
        merged = x.merge(p.drop(columns=['race_date', 'popularity', 'finish_numeric']),
                         on=['race_id', 'horse_number'], validate='one_to_one')
        if len(merged) != len(x) or len(merged) != len(p):
            raise ValueError('Role prediction coverage differs; refusing a reduced sample')
        x = merged
    x = x.reset_index(drop=True)
    x['race_date'] = pd.to_datetime(x.race_date)
    x['market'] = .5*x.first_m + .3*x.second_m + .2*x.third_m
    x['rein'] = .5*x.first_r + .3*x.second_r + .2*x.third_r
    x['current'] = .7*x.market + .3*x.rein
    x['edge'] = (.5*np.log((x.first_r+1e-12)/(x.first_m+1e-12))
                 + .3*np.log((x.second_r+1e-12)/(x.second_m+1e-12))
                 + .2*np.log((x.third_r+1e-12)/(x.third_m+1e-12)))
    x['edge_score'] = x.market*np.exp(.75*x.edge)
    if not np.isfinite(x[['current', 'edge_score', 'second_r', 'third_r']].to_numpy()).all():
        raise ValueError('Non-finite prediction scores')
    if x.race_date.isna().any() or (x.groupby('race_id').race_date.nunique() != 1).any():
        raise ValueError('Invalid or inconsistent race dates')
    return x


def prepare(x: pd.DataFrame):
    x = x.copy().reset_index(drop=True)
    x['_row'] = np.arange(len(x))
    x['_race'], ids = pd.factorize(x.race_id, sort=True)
    races = x[['race_id', 'race_date', '_race']].drop_duplicates('_race')
    races = races.sort_values('_race').reset_index(drop=True)
    # Preserve the original audit's first-listed winner convention for dead heats.
    x['_winner'] = False
    winners = x.loc[x.finish_numeric.eq(1)].drop_duplicates('race_id').index
    x.loc[winners, '_winner'] = True
    e = x.sort_values(['race_id', 'edge_score', 'popularity', 'horse_number'],
                      ascending=[True, False, True, True])
    top4 = e.groupby('race_id', sort=False).head(4)
    base = np.zeros(len(ids), dtype=bool)
    base[top4.loc[top4._winner, '_race'].to_numpy(dtype=int)] = True
    pool = x.loc[~x.index.isin(top4.index)].sort_values(['_race', '_row'])
    return x, races, pool, base


def vectorized(x, races, pool, base, batch_size=24):
    """Evaluate every original candidate; break all ties before counting a hit."""
    hits = np.repeat(base[:, None], len(CONFIGS), axis=1)
    picked = np.full(hits.shape, -1, dtype=np.int64)
    if pool.empty:
        return hits, picked
    codes = pool._race.to_numpy(dtype=int)
    starts = np.r_[0, 1 + np.flatnonzero(codes[1:] != codes[:-1])]
    race_codes = codes[starts]
    local = np.repeat(np.arange(len(starts)), np.diff(np.r_[starts, len(pool)]))
    f = pool[['current', 'edge_score', 'second_r', 'third_r']].to_numpy(dtype=float)
    pop = pool.popularity.fillna(np.inf).to_numpy(dtype=float)
    row = pool._row.to_numpy(dtype=np.int64)
    winner = x._winner.to_numpy(dtype=bool)
    weights = np.array([c[1] for c in CONFIGS], dtype=float)
    for lo in range(0, len(CONFIGS), batch_size):
        hi = min(lo + batch_size, len(CONFIGS))
        w = weights[lo:hi]
        # Match the original expression's order, rather than BLAS reassociation.
        score = (w[:, 0]*f[:, 0, None] + w[:, 1]*f[:, 1, None]
                 + w[:, 2]*f[:, 2, None] + w[:, 3]*f[:, 3, None])
        maximum = np.maximum.reduceat(score, starts, axis=0)
        eligible = score == maximum[local]
        best_current = np.maximum.reduceat(
            np.where(eligible, f[:, 0, None], -np.inf), starts, axis=0)
        eligible &= f[:, 0, None] == best_current[local]
        best_pop = np.minimum.reduceat(
            np.where(eligible, pop[:, None], np.inf), starts, axis=0)
        eligible &= pop[:, None] == best_pop[local]
        chosen = np.minimum.reduceat(
            np.where(eligible, row[:, None], np.iinfo(np.int64).max), starts, axis=0)
        if np.any(chosen >= len(x)):
            raise AssertionError('No unique fifth runner could be selected')
        picked[race_codes, lo:hi] = chosen
        hits[race_codes, lo:hi] |= winner[chosen]
        print(f'Candidates evaluated: {hi}/{len(CONFIGS)}', flush=True)
    return hits, picked


def reference_parity(x, pool, picked, sample_races=18):
    """Check runner identity, not just hit rate, against original pandas sorting."""
    available = np.sort(pool._race.unique())
    sample = available[np.unique(np.linspace(0, len(available)-1,
                                           min(sample_races, len(available)), dtype=int))]
    checks = 0
    for code in sample:
        p = pool[pool._race.eq(code)]
        for k, (_, (wc, we, w2, w3)) in enumerate(CONFIGS):
            z = p.copy()
            z['_boundary'] = wc*z.current + we*z.edge_score + w2*z.second_r + w3*z.third_r
            expected = int(z.sort_values(['_boundary', 'current', 'popularity'],
                                         ascending=[False, False, True]).index[0])
            if expected != picked[int(code), k]:
                raise AssertionError(f'Original/fast mismatch: race={code}, candidate={k}')
            checks += 1
    return {'races': len(sample), 'candidate_runner_checks': checks, 'mismatches': 0}


def baselines(x, races, pool, base):
    output = {}
    for name, column in (('edge5', 'edge_score'), ('current_boundary', 'current')):
        h = base.copy()
        # Original baseline did not use current as an edge_score tie-break.
        chosen = pool.sort_values(['_race', column, 'popularity', '_row'],
                                  ascending=[True, False, True, True]).drop_duplicates('_race')
        h[chosen.loc[chosen._winner, '_race'].to_numpy(dtype=int)] = True
        output[name] = h
    ranked = x.sort_values(['_race', 'current', 'popularity', 'horse_number'],
                           ascending=[True, False, True, True])
    top5 = ranked.groupby('_race', sort=False).head(5)
    h = np.zeros(len(races), dtype=bool)
    h[top5.loc[top5._winner, '_race'].to_numpy(dtype=int)] = True
    output['current_top5'] = h
    return output


def main():
    started = time.monotonic()
    OUT.mkdir(parents=True, exist_ok=True)
    x, races, pool, base = prepare(load())
    print(f'Loaded {len(x)} runners / {len(races)} races', flush=True)
    hits, picked = vectorized(x, races, pool, base)
    parity = reference_parity(x, pool, picked)
    (OUT/'parity.json').write_text(json.dumps(parity, indent=2))
    masks = {n: races.race_date.between(lo, hi).to_numpy()
             for n, (lo, hi) in PERIODS.items()}
    if any(not m.any() for m in masks.values()):
        raise ValueError('A required selection/confirmation/audit period is empty')
    rows = []
    for period, mask in masks.items():
        count = hits[mask].sum(axis=0)
        for k, (name, _) in enumerate(CONFIGS):
            rows.append({'candidate': name, 'period': period, 'races': int(mask.sum()),
                         'hits': int(count[k]), 'rate': float(count[k]/mask.sum())})
    grid = pd.DataFrame(rows)
    grid.to_csv(OUT/'grid.csv', index=False)
    # Select on H1 only. Never optimize on H2 or the 2026 retrospective audit.
    selected = grid[grid.period.eq('h1')].sort_values(
        ['hits', 'candidate'], ascending=[False, True]).iloc[0].candidate
    k = next(i for i, c in enumerate(CONFIGS) if c[0] == selected)
    comparisons = {'selected': hits[:, k], **baselines(x, races, pool, base)}
    report = {
        'selected': selected, 'weights': CONFIGS[k][1], 'candidate_count': len(CONFIGS),
        'selection': '2025H1 only; edge Top4 frozen; choose fifth by max Top5 hits',
        'production_changed': False,
        'benchmark_rate': .8215,
        'current_top5_definition': '0.7*(0.5*first_m+0.3*second_m+0.2*third_m) + 0.3*(0.5*first_r+0.3*second_r+0.2*third_r)',
        'metric': 'Top5 contains the first-listed winning horse, as in original audit',
        'audit_caveat': '2026 is retrospective and previously inspected, not an untouched future holdout',
        'source_run_id': 36135569462,
        'source_artifact_id': 10865425162,
        'commit_sha': os.environ.get('GITHUB_SHA'),
        'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'parity': parity,
        'dead_heat_races': int((x.groupby('race_id').finish_numeric.apply(lambda s: s.eq(1).sum()) > 1).sum()),
        'under_five_runner_races': int((x.groupby('race_id').size() < 5).sum()),
        'periods': {},
    }
    for period, mask in masks.items():
        summary = {}
        for label, h in comparisons.items():
            summary[label] = {'hits': int(h[mask].sum()), 'races': int(mask.sum()),
                              'rate': float(h[mask].mean())}
        a, b = comparisons['selected'][mask], comparisons['current_top5'][mask]
        summary['comparison'] = {
            'delta_pp': float(100*(a.mean()-b.mean())),
            'gained_races': int((a & ~b).sum()), 'lost_races': int((~a & b).sum()),
            'beats_current': bool(a.sum() > b.sum()),
            'beats_82_15_percent': bool(a.mean() > .8215),
            'current_rounds_to_82_15_percent': bool(round(float(b.mean())*100, 2) == 82.15),
            'first_date': str(races.loc[mask, 'race_date'].min().date()),
            'last_date': str(races.loc[mask, 'race_date'].max().date()),
        }
        report['periods'][period] = summary
    report['beats_current_in_both_h2_and_2026'] = all(
        report['periods'][n]['comparison']['beats_current'] for n in ('h2', 'audit'))
    per_race = races[['race_id', 'race_date']].copy()
    for name, h in comparisons.items():
        per_race[name] = h.astype(int)
    selected_rows = picked[:, k]
    per_race['selected_fifth_horse'] = [
        int(x.loc[r, 'horse_number']) if r >= 0 else None for r in selected_rows]
    per_race.to_csv(OUT/'per_race.csv.gz', index=False, compression='gzip')
    report['elapsed_seconds'] = round(time.monotonic()-started, 3)
    (OUT/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
            f.write('## Fifth-boundary audit (research only)\n```json\n')
            f.write(json.dumps(report, ensure_ascii=False, indent=2)+'\n```\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT/'failure.txt').write_text(traceback.format_exc())
        raise
