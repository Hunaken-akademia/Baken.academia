"""Reproducible outsider ranking audit of saved auxiliary predictions; no production adoption."""
import argparse
import json
from pathlib import Path
import pandas as pd


def audit(root):
    rows = []
    for role, finish in [('first', 1), ('second', 2), ('third', 3)]:
        frame = pd.read_parquet(root / role / 'predictions.parquet')
        if frame.duplicated(['race_id', 'horse_number']).any() or frame.popularity.isna().any() or (frame.popularity < 1).any():
            raise ValueError('Invalid runner identity or popularity')
        for model in ['rank_only', 'real_odds_market', 'real_odds_plus_all']:
            if not frame[model].map(lambda x: pd.notna(x) and abs(x) != float('inf')).all():
                raise ValueError(f'Incomplete predictions: {model}')
        frame['race_date'] = pd.to_datetime(frame['race_date'])
        partitions = {
            '2025H1': frame[frame.race_date.between('2025-01-01', '2025-06-30')],
            '2025H2': frame[frame.race_date.between('2025-07-01', '2025-12-31')],
            '2026_retrospective': frame[frame.race_date.dt.year == 2026],
        }
        for period, data in partitions.items():
            for minimum in [4, 6, 10]:
                pool = data[data.popularity >= minimum]
                actual = pool[pool.finish_numeric == finish]
                eligible = actual.race_id.nunique()
                for model in ['popularity', 'rank_only', 'real_odds_market', 'real_odds_plus_all']:
                    ordered = pool.sort_values(['race_id', model, 'horse_number'], ascending=[True, model == 'popularity', True])
                    for count in [1, 2, 3]:
                        selected = ordered.groupby('race_id', sort=False).head(count)
                        hit = selected[selected.finish_numeric == finish]
                        rows.append(dict(role=role, period=period, min_popularity=minimum, candidates=count, model=model,
                            races=int(data.race_id.nunique()), outsider_finish_races=int(eligible), selected_horses=len(selected),
                            selected_races=int(selected.race_id.nunique()), exact_hits=int(hit.race_id.nunique()),
                            outsider_capture=float(hit.race_id.nunique()/eligible) if eligible else None,
                            exact_precision=float(len(hit)/len(selected)) if len(selected) else None))
    return {
        'scope': 'JRA auxiliary frozen market research models, NOT current REIN serving role models',
        'training': '2019-2024; predictions 2025-01-05 to 2026-09-13',
        'limitations': ['Final popularity/odds are used, not certified pre-race snapshots.',
                       '2026 was previously inspected and is retrospective, not a new untouched test.',
                       'No ROI or ticket profit is calculated; exact second/third finishes are evaluated separately.',
                       'Horse-number tie breaks differ from serving stable overall-rank ties.',
                       'No selection rule or production model is adopted from these results.'],
        'metrics': 'outsider_capture = races with selected exact finisher / races with actual exact finisher meeting popularity threshold; exact_precision = selected exact finish horses / all selected horses',
        'results': rows,
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--predictions', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = audit(args.predictions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    for row in report['results']:
        if row['period'] == '2026_retrospective' and row['min_popularity'] == 6 and row['candidates'] == 3:
            print(json.dumps(row, ensure_ascii=False))
