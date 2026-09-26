"""Read-only feature parity diagnostics against the frozen research implementation."""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path
import numpy as np
import pandas as pd

REFERENCE = 'c1d0a7db4aed063d3a7fe0004616344b5afa9dd3'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', required=True)
    p.add_argument('--odds', required=True)
    a = p.parse_args()
    out = Path(a.output)
    root, = [p for p in (out / 'bundle').iterdir() if p.is_dir()]
    reference = out / 'reference'
    reference.mkdir(exist_ok=True)
    for name in ['rein_blend_top5_audit.py', 'rein_market_edge_research.py']:
        content = subprocess.check_output(['git', 'show', f'{REFERENCE}:scripts/{name}'])
        (reference / name).write_bytes(content)
    sys.path.insert(0, str(reference.resolve()))
    sys.path.insert(0, str(Path('rein-web/api').resolve()))
    from rein_blend_top5_audit import build_features
    from rein_market_edge_research import new_features
    from verify_rein_market_runtime import load_odds
    import rein_core as core
    runtime = core.ReinRuntime.load(root, root.name)
    raw = pd.read_parquet(root / 'data/history.parquet')
    x, base = build_features(raw, core)
    odds = load_odds(a.odds)
    parity = pd.read_csv(out / 'parity.csv')
    selected = list(dict.fromkeys(parity.race_id))
    diffs = []
    checks = []
    for role, target in [('first', 1), ('second', 2), ('third', 3)]:
        expected, _ = new_features(x, base, target)
        model = runtime.market_models[role]['rein']
        columns = model.feature_name()
        for rid in selected:
            group = x.loc[x.race_id.eq(rid)].sort_values('horse_number')
            r = group.iloc[0]
            race = {'race_date': str(pd.Timestamp(r.race_date).date()), 'racecourse': r.racecourse,
                    'surface': r.surface, 'distance_m': float(r.distance_m), 'going': r.going, 'race_class': r.race_class}
            fields = ['horse_number','gate','horse_id','jockey_id','trainer_id','age','sex',
                      'weight_carried','horse_weight','horse_weight_change','popularity']
            runners = json.loads(group[fields].to_json(orient='records'))
            by_number = odds.loc[odds.race_id.eq(rid)].set_index('horse_number').win_odds.to_dict()
            for runner in runners:
                runner['win_odds'] = float(by_number[runner['horse_number']])
            full = runtime._feature_frame_full(race, runners)
            actual = runtime._market_feature_frame(full, race, runners, target, columns)
            exp = expected.loc[group.index].reset_index(drop=True)
            win = pd.Series([item['win_odds'] for item in runners])
            share = (1 / win) / (1 / win).sum()
            exp['odds_log_win'] = np.log(win)
            exp['odds_win_share'] = share
            exp['odds_favorite_share'] = share.max()
            exp['odds_entropy'] = float((-share * np.log(share)).sum())
            exp['odds_concentration'] = float((share ** 2).sum())
            exp['odds_relative_to_favorite'] = np.log(share / share.max())
            exp['odds_log_rank'] = np.log(win.rank(method='min'))
            exp = exp[columns]
            for column in columns:
                if column in core.CATEGORICAL:
                    av, ev = actual[column].astype(str).to_numpy(), exp[column].astype(str).to_numpy()
                    mask = av != ev
                else:
                    av, ev = actual[column].to_numpy(float), exp[column].to_numpy(float)
                    mask = ~np.isclose(av, ev, rtol=0, atol=0, equal_nan=True)
                for i in np.flatnonzero(mask):
                    diffs.append({'race_id': rid, 'horse_number': int(runners[i]['horse_number']),
                                  'role': role, 'feature': column, 'actual': str(av[i]),
                                  'expected': str(ev[i]), 'abs_error': None if column in core.CATEGORICAL else float(abs(av[i]-ev[i]))})
            v = np.clip(model.predict(exp), 1e-12, None); v /= v.sum()
            stored = parity.loc[(parity.race_id.eq(rid)) & (parity.role.eq(role)) & parity.kind.eq('rein')].set_index('horse_number')
            max_error = max(abs(v[i] - float(stored.loc[int(row['horse_number']), 'expected'])) for i, row in enumerate(runners))
            checks.append({'role': role, 'race_id': rid, 'reference_vs_saved_error': max_error})
    frame = pd.DataFrame(diffs)
    frame.to_csv(out / 'feature-differences.csv', index=False)
    (out / 'feature-reference-checks.json').write_text(json.dumps(checks, indent=2, ensure_ascii=False))
    print('Frozen reference versus saved predictions:', json.dumps(checks, ensure_ascii=False), flush=True)
    print('Largest feature differences:')
    print(frame.sort_values('abs_error', ascending=False).head(40).to_string(index=False))
    print('Feature maxima:')
    print(frame.groupby('feature').abs_error.max().sort_values(ascending=False).head(40).to_string())


if __name__ == '__main__':
    main()
