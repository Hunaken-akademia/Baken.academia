"""Incremental nine-bet NAR research. Official payouts settle every ticket.

Final odds are an ex-post market reference, never claimed to be available at
purchase time. No coefficient or production bet is changed by this report.
"""
from __future__ import annotations

import argparse
import itertools
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

try:
    from nar_live_model import normalize_courses, prior_features, inputs_by_mode
except ModuleNotFoundError:
    from scripts.nar_live_model import normalize_courses, prior_features, inputs_by_mode

LABELS = {'win': '単勝', 'place': '複勝', 'bracket_quinella': '枠連複',
          'bracket_exacta': '枠連単', 'quinella': '馬連複', 'exacta': '馬連単',
          'wide': 'ワイド', 'trio': '三連複', 'trifecta': '三連単'}
ALIASES = {label: bet for bet, label in LABELS.items()}
ALIASES.update({'枠連': 'bracket_quinella', '枠複': 'bracket_quinella',
                '枠単': 'bracket_exacta', '馬連': 'quinella', '馬複': 'quinella',
                '馬単': 'exacta', '3連複': 'trio', '3連単': 'trifecta'})
PAGE = {'win': 'win_place', 'place': 'win_place',
        'bracket_quinella': 'bracket_quinella', 'bracket_exacta': 'bracket_quinella',
        'quinella': 'quinella', 'exacta': 'exacta', 'wide': 'wide',
        'trio': 'trio', 'trifecta': 'trifecta'}
ORDERED = {'bracket_exacta', 'exacta', 'trifecta'}


def payout_map(payload):
    rows = json.loads(payload or '[]') if isinstance(payload, str) else payload
    result = defaultdict(dict)
    for row in rows or []:
        label = re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(row.get('bet_type', ''))))
        bet = ALIASES.get(label)
        if not bet:
            continue
        text = unicodedata.normalize('NFKC', str(row.get('combination', '')))
        if re.search(r'返還|特払|不成立', text):
            continue
        numbers = tuple(map(int, re.findall(r'\d+', text)))
        size = 1 if bet in {'win', 'place'} else 3 if bet in {'trio', 'trifecta'} else 2
        if len(numbers) != size:
            continue
        selection = numbers if bet in ORDERED else tuple(sorted(numbers))
        value = row.get('payout_yen')
        if value is None or not np.isfinite(float(value)) or float(value) <= 0:
            continue
        if selection in result[bet] and result[bet][selection] != float(value):
            raise ValueError('Conflicting official payout')
        result[bet][selection] = float(value)
    return dict(result)


def selections(ranked, bet, count):
    chosen = ranked[:count]
    if bet in {'win', 'place'}:
        return {(horse,) for horse, gate in chosen}
    width = 3 if bet in {'trio', 'trifecta'} else 2
    groups = itertools.permutations(chosen, width) if bet in ORDERED else itertools.combinations(chosen, width)
    result = set()
    for group in groups:
        values = tuple(row[1] if bet.startswith('bracket_') else row[0] for row in group)
        result.add(values if bet in ORDERED else tuple(sorted(values)))
    return result


def metrics(total):
    races = total.get('races', 0)
    spend = total.get('spend_yen', 0)
    return {**total, 'race_hit_rate': total.get('hits', 0) / races if races else None,
            'roi': total.get('return_yen', 0) / spend if spend else None,
            'average_tickets': total.get('tickets', 0) / races if races else None}


def market_coverage(root):
    """Read each manifest separately; avoid loading the large odds-cell tables."""
    pages = defaultdict(set)
    empty_pages = 0
    chunks = 0
    for path in sorted(root.rglob('*-odds-manifest.parquet')):
        chunks += 1
        frame = pd.read_parquet(path, columns=['race_id', 'bet_type', 'cells'])
        for row in frame.itertuples(index=False):
            if int(row.cells) <= 0:
                empty_pages += 1
            else:
                pages[str(row.race_id)].add(str(row.bet_type))
    return pages, chunks, empty_pages


def research_scores(data):
    """Fixed hybrid model; train 2019-2024, never refit on evaluation results."""
    x = inputs_by_mode(prior_features(data), data.race_id)['hybrid']
    train = data.race_date.lt('2025-01-01').to_numpy()
    if train.sum() < 1000:
        return None
    scaler = StandardScaler().fit(x[train])
    transformed = scaler.transform(x)
    scores = []
    for target in (1, 2, 3):
        y = data.finish_position.eq(target).to_numpy()
        if len(np.unique(y[train])) < 2:
            return None
        model = LogisticRegression(C=0.1, max_iter=250).fit(transformed[train], y[train])
        scores.append(model.decision_function(transformed))
    logits = np.mean(scores, axis=0)
    logits[train] = np.nan  # Never report in-sample performance as research validation.
    return logits


def build_report(input_file, market_dir, output_dir):
    pages, chunks, empty_pages = market_coverage(market_dir)
    data = normalize_courses(pd.read_parquet(input_file))
    data['race_date'] = pd.to_datetime(data.race_date, errors='coerce')
    for key in ('finish_position', 'horse_number', 'gate', 'popularity', 'win_odds', 'distance_m'):
        data[key] = pd.to_numeric(data[key], errors='coerce')
    data = data.sort_values(['race_date', 'race_id', 'horse_number']).drop_duplicates(['race_id', 'horse_id']).reset_index(drop=True)
    data['race_id'] = data.race_id.astype(str)
    has_holdout = data.loc[data.race_id.isin(pages), 'race_date'].ge('2025-01-01').any()
    score = research_scores(data) if has_holdout else None
    data['research_score'] = score if score is not None else np.nan
    totals = defaultdict(lambda: defaultdict(float))
    eligible = defaultdict(int)
    skipped = defaultdict(int)
    processed = 0
    dates = []
    for race_id, group in data.loc[data.race_id.isin(pages)].groupby('race_id', sort=False):
        if group.race_date.isna().any():
            skipped['invalid_date'] += 1
            continue
        # Non-finishers remain starters; cancellations/refunds need dedicated handling.
        status = group.get('finish_status', pd.Series('', index=group.index)).fillna('').astype(str)
        if status.str.contains('取消|除外|中止|失格').any() or group[['horse_number', 'gate']].isna().any().any():
            skipped['cancelled_or_nonfinishers'] += 1
            continue
        if group.horse_number.duplicated().any():
            skipped['duplicate_runner'] += 1
            continue
        try:
            payouts = payout_map(group.payouts.iloc[0])
        except (ValueError, TypeError, json.JSONDecodeError):
            skipped['invalid_payout'] += 1
            continue
        if not payouts:
            skipped['missing_payout'] += 1
            continue
        processed += 1
        date = group.race_date.iloc[0]
        dates.append(date)
        period = '2026_audit' if date.year >= 2026 else '2025_validation' if date.year == 2025 else '2019_2024_market_reference'
        rankings = {}
        if group.popularity.notna().all() and group.popularity.ge(1).all():
            rankings['final_market_reference'] = group.sort_values(['popularity', 'horse_number'])
        if group.research_score.notna().all():
            rankings['temporal_history_research'] = group.sort_values(['research_score', 'horse_number'], ascending=[False, True])
        for bet in LABELS:
            # Absent payout = unsupported/missing, not a losing race.
            if bet not in payouts or PAGE[bet] not in pages[race_id]:
                continue
            eligible[bet] += 1
            for method, ranking in rankings.items():
                runners = [(int(row.horse_number), int(row.gate)) for row in ranking.itertuples()]
                for count in (1, 3, 5):
                    tickets = selections(runners, bet, count)
                    if not tickets:
                        continue
                    returns = sum(payouts[bet].get(ticket, 0) for ticket in tickets)
                    key = (period, method, bet, count)
                    t = totals[key]
                    t['races'] += 1
                    t['hits'] += int(returns > 0)
                    t['tickets'] += len(tickets)
                    t['spend_yen'] += 100 * len(tickets)
                    t['return_yen'] += returns
    report = {
        'status': 'partial_research', 'production_changed': False,
        'coverage': {'market_chunks': chunks, 'market_races': len(pages), 'settled_races': processed,
                     'empty_odds_pages': empty_pages, 'eligible_races_by_bet': dict(eligible),
                     'skipped': dict(skipped), 'date_from': str(min(dates).date()) if dates else None,
                     'date_to': str(max(dates).date()) if dates else None},
        'policy': {'stake_yen_per_ticket': 100, 'strategies': 'rank top1 / top3 box / top5 box; unique combinations',
                   'training': '2019-2024', 'validation': '2025', 'untouched_audit': '2026',
                   'model': 'research-only fixed hybrid mean of three exact-place logits; not production REIN',
                   'market_reference': 'final popularity; ex-post reference, not executable prestart odds',
                   'settlement': 'official payouts; missing/unsupported/refund races excluded, not treated as losses',
                   'odds_use': 'manifest page coverage and availability; raw table prices are not yet decoded for EV filters'},
        'results': [{ 'period': p, 'method': m, 'bet': bet, 'label': LABELS[bet],
                     'top_k': k, **metrics(t)} for (p, m, bet, k), t in sorted(totals.items())],
        'notes': ['Only acquired full-odds periods are evaluated.',
                  'History validation waits for 2025/2026 market periods; never reports training fit as accuracy.',
                  'Bracket exacta and bracket quinella are separate; settle only where officially offered.'],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = ['# 地方競馬・全券種並行分析', '', f'- 全券種データ: {chunks}区間 / {len(pages):,}レース',
             '- 単勝・複勝・枠連複・枠連単・馬連複・馬連単・ワイド・三連複・三連単',
             '- 各100円、上位1頭・3頭BOX・5頭BOX。重複買い目は除外。',
             '- 人気順は確定人気による参考比較。研究モデルは2019〜2024学習、2025検証、2026監査。',
             '- 本番REINの的中率とは別の研究集計。オッズ価格の解読・期待値フィルタは未導入。', '',
             '| 期間 | 方式 | 券種 | 上位頭数 | 対象R | 的中率 | 回収率 | 平均点数 |',
             '|---|---|---|---:|---:|---:|---:|---:|']
    for row in report['results']:
        lines.append(f"| {row['period']} | {row['method']} | {row['label']} | {row['top_k']} | {int(row['races'])} | {row['race_hit_rate']:.2%} | {row['roi']:.2%} | {row['average_tickets']:.1f} |")
    if score is None:
        lines.extend(['', '※ 全券種オッズの2025/2026区間到着後に、未学習期間の研究モデル比較を自動開始します。'])
    (output_dir / 'summary.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps(report['coverage'], ensure_ascii=False), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-file', type=Path, required=True)
    parser.add_argument('--market-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    build_report(args.input_file, args.market_dir, args.output_dir)


if __name__ == '__main__':
    main()
