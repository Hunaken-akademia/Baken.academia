"""NAR role-based ticket research, settled with official payouts.

Historical reconstruction, not authentic saved prestart predictions. Model and
ticket selection use 2025; 2026 is a subsequent check, never a selection input.
Ranking weights are not calibrated probabilities. No production rule is changed.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

try:
    from nar_all_bet_analysis import LABELS as ALL_LABELS, ORDERED, metrics, payout_map
    from nar_live_model import fit_live_model, inputs_by_mode, normalize_courses, prior_features
except ModuleNotFoundError:
    from scripts.nar_all_bet_analysis import LABELS as ALL_LABELS, ORDERED, metrics, payout_map
    from scripts.nar_live_model import fit_live_model, inputs_by_mode, normalize_courses, prior_features

LABELS = {bet: label for bet, label in ALL_LABELS.items() if bet != 'trifecta'}

POINTS = (1, 3, 5, 10, 20, 30)
METHODS = ('current_70_30', 'role_50', 'role_100', 'role_formation')


def normalize(values):
    a = np.maximum(np.nan_to_num(np.asarray(values, dtype=float), nan=0, posinf=0, neginf=0), 1e-9)
    return a / a.sum()


def generate_candidates(horses, roles, popularity, method):
    """Return unique, ordered candidates for the eight allowed bets from three role shares.

horses is [(horse_number, gate)], roles is N x 3. Scores only rank tickets.
The current_70_30 path reproduces the live generator's nine-horse pool and
same-gate exclusion; candidate paths permit valid same-gate bracket tickets.
"""
    if method not in METHODS:
        raise ValueError('Unknown ticket method')
    if len(horses) != len(roles) or len(horses) != len(popularity):
        raise ValueError('Mismatched runner arrays')
    if len({h[0] for h in horses}) != len(horses) or len(horses) < 3:
        raise ValueError('Distinct runners required')
    roles = np.asarray(roles, dtype=float)
    if roles.shape != (len(horses), 3) or not np.isfinite(roles).all():
        raise ValueError('Invalid role shares')
    market = normalize([1 / max(float(p), 1) if np.isfinite(p) and p > 0 else 1 / (len(horses) + 1) for p in popularity])
    roles = np.column_stack([normalize(roles[:, i]) for i in range(3)])
    weight = {'current_70_30': .3, 'role_50': .5, 'role_100': 1, 'role_formation': 1}[method]
    roles = weight * roles + (1 - weight) * market[:, None]
    # Match the existing bounded pool; deterministic ties use horse number.
    pool = sorted(range(len(horses)), key=lambda i: (-max(roles[i]), horses[i][0]))[:9]
    horses = [horses[i] for i in pool]
    roles = roles[pool]
    roles = np.column_stack([normalize(roles[:, i]) for i in range(3)])
    values = {bet: defaultdict(float) for bet in LABELS}
    def add(bet, selection, score):
        key = tuple(selection) if bet in ORDERED else tuple(sorted(selection))
        values[bet][key] += float(score)
    n = len(horses)
    rank = np.empty_like(roles, dtype=int)
    for target in range(3):
        for pos, i in enumerate(sorted(range(n), key=lambda i: (-roles[i, target], horses[i][0])), 1):
            rank[i, target] = pos
    for i, (horse, gate) in enumerate(horses):
        add('win', (horse,), roles[i, 0])
        add('place', (horse,), roles[i].sum())
    for i, j in itertools.permutations(range(n), 2):
        if method == 'role_formation' and (rank[i, 0] > 3 or rank[j, 1] > 5):
            continue
        h1, g1 = horses[i]; h2, g2 = horses[j]
        score = roles[i, 0] * roles[j, 1] / max(1 - roles[i, 1], 1e-12)
        add('exacta', (h1, h2), score)
        add('quinella', (h1, h2), score)
        if method != 'current_70_30' or g1 != g2:
            add('bracket_quinella', (g1, g2), score)
        add('bracket_exacta', (g1, g2), score)
    for i, j, k in itertools.permutations(range(n), 3):
        if method == 'role_formation' and (rank[i, 0] > 3 or rank[j, 1] > 5 or rank[k, 2] > 5):
            continue
        hs = (horses[i][0], horses[j][0], horses[k][0])
        score = roles[i, 0] * roles[j, 1] / max(1 - roles[i, 1], 1e-12)
        score *= roles[k, 2] / max(1 - roles[i, 2] - roles[j, 2], 1e-12)
        add('trio', hs, score)
        for pair in itertools.combinations(hs, 2):
            add('wide', pair, score)
    return {bet: sorted(rows.items(), key=lambda row: (-row[1], row[0])) for bet, rows in values.items()}


def pick_tickets(candidates, bet, budget_yen, odds=None, min_odds=0):
    """Uniform 100-yen stake. Odds filtering requires actual ticket odds."""
    if budget_yen < 0:
        raise ValueError('Negative budget')
    if min_odds > 0 and odds is None:
        raise ValueError('Ticket odds required for an odds filter')
    return [ticket for ticket, score in candidates[bet]
            if min_odds <= 0 or (ticket in odds and np.isfinite(odds[ticket]) and odds[ticket] >= min_odds)][:budget_yen // 100]


def settle(tickets, payouts):
    # A missing payout table is excluded by the caller, not settled as a loss.
    returns = sum(payouts.get(tuple(ticket), 0) for ticket in set(tickets))
    return {'races': 1, 'hits': int(returns > 0), 'tickets': len(set(tickets)),
            'spend_yen': 100 * len(set(tickets)), 'return_yen': returns}


def compare_results(rows):
    indexed = {(r['period'], r['method'], r['bet'], r['points'], r.get('filter', 'all')): r for r in rows}
    selected = []
    for bet in LABELS:
        for points in POINTS:
            validation = [r for r in rows if r['period'] == '2025_selection' and r['bet'] == bet
                          and r['points'] == points and r['method'] != 'current_70_30' and r['races'] >= 500]
            if not validation:
                continue
            # Only 2025 chooses the method; never choose whichever wins in 2026.
            choice = max(validation, key=lambda r: (r['roi'], r['race_hit_rate'], r['method']))
            audit = indexed.get(('2026_check', choice['method'], bet, points, choice.get('filter', 'all')))
            peer = indexed.get(('2026_check', 'current_70_30', bet, points, choice.get('filter', 'all')))
            selection_peer = indexed.get(('2025_selection', 'current_70_30', bet, points, choice.get('filter', 'all')))
            comparable = audit and peer and audit['races'] == peer['races'] and audit['races'] >= 500
            if comparable and audit.get('race_set_hash') != peer.get('race_set_hash'):
                comparable = False
            passed = bool(comparable and selection_peer and choice['roi'] >= selection_peer['roi']
                          and audit['roi'] >= 1 and audit['roi'] >= peer['roi'] and audit['race_hit_rate'] >= peer['race_hit_rate'])
            selected.append({'bet': bet, 'label': LABELS[bet], 'points': points,
                             'method_selected_in_2025': choice['method'], 'filter_selected_in_2025': choice.get('filter', 'all'), 'selection': choice,
                             'check_2026': audit, 'baseline_2026': peer,
                             'decision': 'candidate_for_review' if passed else 'hold'})
    return selected


def odds_conditions(group, candidates):
    """Final single-win odds bands: reference research, not prestart snapshots."""
    odds = dict(zip(group.horse_number.astype(int), group.win_odds))
    favorites = group.loc[group.popularity.eq(1), 'win_odds']
    favorite = float(favorites.iloc[0]) if len(favorites) == 1 else np.nan
    leader = candidates['win'][0][0][0]
    axis = odds.get(leader, np.nan)
    conditions = ['all']
    if np.isfinite(favorite) and favorite >= 1:
        if favorite < 2: conditions.append('favorite_1_2')
        elif favorite < 3: conditions.append('favorite_2_3')
        elif favorite < 5: conditions.append('favorite_3_5')
        else: conditions.append('favorite_5plus')
    if np.isfinite(axis) and axis >= 1:
        conditions.append('axis_1_3' if axis < 3 else 'axis_3_10' if axis < 10 else 'axis_10plus')
    return conditions


def build_report(input_dir, output_dir, odds_filters=False):
    files = [p for p in sorted(input_dir.rglob('nar-*.parquet'))
             if not any(tag in p.name for tag in ('-odds-', '-payouts', '-manifest'))]
    if not files:
        raise ValueError('No result archives')
    data = normalize_courses(pd.concat([pd.read_parquet(p) for p in files], ignore_index=True))
    data['race_date'] = pd.to_datetime(data.race_date, errors='coerce')
    for key in ('horse_number', 'gate', 'finish_position', 'popularity', 'win_odds', 'distance_m'):
        data[key] = pd.to_numeric(data[key], errors='coerce')
    original_status = data.get('finish_status', pd.Series('', index=data.index)).fillna('').astype(str)
    invalid_races = set(data.loc[original_status.str.contains('取消|除外|中止|失格') | data.finish_position.isna(), 'race_id'])
    data = data.loc[data.finish_position.notna()].sort_values(['race_date', 'race_id', 'horse_number'])
    data = data.drop_duplicates(['race_id', 'horse_id']).reset_index(drop=True)
    model = fit_live_model(data)
    if model.get('status') != 'provisional':
        raise ValueError('Role model has insufficient chronological coverage')
    modes = inputs_by_mode(prior_features(data), data.race_id)
    for target in (1, 2, 3):
        role = model['roles'][str(target)]
        logits = float(role['intercept']) + modes[role['mode']] @ np.asarray(role['coef'])
        data[f'role_{target}'] = 1 / (1 + np.exp(-np.clip(logits, -50, 50)))
    del modes
    total = defaultdict(lambda: defaultdict(float))
    race_hashes = defaultdict(int)
    skipped = defaultdict(int)
    examples = []
    checked = 0
    for race_id, group in data.loc[data.race_date.ge('2025-01-01')].groupby('race_id', sort=False):
        status = group.get('finish_status', pd.Series('', index=group.index)).fillna('').astype(str)
        # Compare only races with all starters present; a nonfinisher must not
        # disappear from a reconstructed prestart field.
        if race_id in invalid_races or status.str.contains('取消|除外|中止|失格').any() or group[['horse_number', 'gate']].isna().any().any() or len(group) < 3:
            skipped['invalid_or_refund_field'] += 1; continue
        try:
            payouts = payout_map(group.payouts.iloc[0])
        except (ValueError, TypeError):
            skipped['invalid_payout'] += 1; continue
        if not payouts:
            skipped['missing_payout'] += 1; continue
        period = '2025_selection' if group.race_date.iloc[0].year == 2025 else '2026_check'
        horses = [(int(r.horse_number), int(r.gate)) for r in group.itertuples()]
        roles = group[['role_1', 'role_2', 'role_3']].to_numpy()
        popularity = group.popularity.to_numpy()
        for method in METHODS:
            candidates = generate_candidates(horses, roles, popularity, method)
            filters = odds_conditions(group, candidates) if odds_filters else ['all']
            for bet in payouts:
                if bet not in LABELS:
                    continue
                for condition in filters:
                    for points in POINTS:
                        tickets = pick_tickets(candidates, bet, 100 * points)
                        if not tickets:
                            continue
                        key = (period, method, bet, points, condition)
                        race_hashes[key] ^= int.from_bytes(hashlib.sha256(str(race_id).encode()).digest(), 'big')
                        for k, value in settle(tickets, payouts[bet]).items():
                            total[key][k] += value
                        if len(examples) < 36 and method == 'role_formation' and points == 10:
                            examples.append({'race_id': str(race_id), 'race_date': str(group.race_date.iloc[0].date()),
                                             'bet': bet, 'selections': tickets, 'stake_yen': len(tickets) * 100,
                                             'kind': 'historical_reconstruction'})
        checked += 1
        if checked % 1000 == 0:
            print(f'Settled role tickets: {checked} races', flush=True)
    rows = [{'period': p, 'method': m, 'bet': b, 'label': LABELS[b], 'points': k, 'filter': condition, 'race_set_hash': hex(race_hashes[(p, m, b, k, condition)]), **metrics(t)}
            for (p, m, b, k, condition), t in sorted(total.items())]
    report = {'status': 'completed', 'production_changed': False,
              'policy': {'training': '2019-2024', 'model_and_ticket_selection': '2025', 'subsequent_check': '2026',
                         'kind': 'historical_reconstruction_not_prestart_snapshots',
                         'scores': 'ranking weights, not calibrated ticket probabilities',
                         'stake': '100 yen equally per ticket; per-bet budgets 100/300/500/1000/2000/3000 yen',
                         'odds_filters': 'final favorite and axis single-win odds bands' if odds_filters else 'not applied',
                         'new_types': 'bracket exacta is a research extension; trifecta excluded from ticket generation',
                         'selection': 'choose highest ROI on 2025 only, then compare with same-budget baseline on 2026'},
              'coverage': {'chunks': len(files), 'evaluated_races': checked, 'skipped': dict(skipped)},
              'results': rows, 'candidate_review': compare_results(rows), 'examples': examples}
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (output_dir / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = ['# 地方競馬・買い目検証（三連単除外）', '',
             '- 締切前の保存予想ではなく、過去履歴からの再現計算です。',
             '- 2019〜2024学習、2025選択、2026確認。各点100円の均等購入。',
             '- 同じ予算上限で現行7:3方式、適性50%、適性100%、着順別フォーメーションを比較。',
             '- 単勝確定オッズ帯でレースを絞ります。組み合わせ価格・期待値フィルタは未適用。本番買い目はまだ変更していません。' if odds_filters else '- オッズ条件は未適用。本番買い目はまだ変更していません。', '',
             '|期間|方式|オッズ条件|券種|上限点数|対象R|的中率|回収率|平均点数|', '|---|---|---|---|---:|---:|---:|---:|---:|']
    for r in rows:
        lines.append(f"|{r['period']}|{r['method']}|{r['filter']}|{r['label']}|{r['points']}|{int(r['races'])}|{r['race_hit_rate']:.2%}|{r['roi']:.2%}|{r['average_tickets']:.1f}|")
    (output_dir / 'summary.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps(report['coverage'], ensure_ascii=False), flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--odds-filters', action='store_true')
    args = parser.parse_args()
    build_report(args.input_dir, args.output_dir, args.odds_filters)
