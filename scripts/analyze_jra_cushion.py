"""Retrospective cushion research with fixed chronological holdouts. No publishing.

Historical going, field sizes and archived measurement publication cannot all be
verified as prestart facts. Results are research, not a live forecast backtest.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

CAT = ['racecourse', 'going', 'distance_band', 'month', 'prior_style']
NUM = ['gate_fraction', 'field_size', 'age_value', 'weight_value', 'prior_finish', 'prior_win']
EXTRA = ['cushion', 'cushion_front', 'cushion_rear']


def corner(value):
    try:
        values = json.loads(value) if isinstance(value, str) else value
        if not isinstance(values, (list, np.ndarray)) or not len(values): return np.nan
        first = float(values[0])
        return first if 0 < first <= 18 else np.nan
    except (ValueError, TypeError, json.JSONDecodeError):
        return np.nan


def history_features(data):
    data = data.sort_values(['race_date', 'race_id', 'horse_number']).reset_index(drop=True).copy()
    data['field_size'] = data.groupby('race_id').horse_number.transform('size')
    data['_corner'] = data.corner_positions.map(corner) / data.field_size
    data['_finish'] = data.finish_position / data.field_size
    data['prior_style'] = 'unknown'
    data['prior_finish'] = np.nan
    data['prior_win'] = np.nan
    for _, horse in data.loc[data.horse_id.notna() & data.horse_id.astype(str).ne('')].groupby('horse_id'):
        history = []
        for day, group in horse.groupby('race_date', sort=False):
            past = [r for r in history[-5:] if (pd.Timestamp(day)-pd.Timestamp(r[0])).days <= 180]
            positions = [r[1] for r in past if pd.notna(r[1]) and 0 < r[1] <= 1]
            finishes = [r for r in past if pd.notna(r[2])]
            if len(positions) >= 2:
                mean = np.mean(positions)
                data.loc[group.index, 'prior_style'] = 'front' if mean <= 1/3 else 'middle' if mean <= 2/3 else 'rear'
            if finishes:
                data.loc[group.index, 'prior_finish'] = np.mean([r[2] for r in finishes])
                data.loc[group.index, 'prior_win'] = np.mean([r[3] for r in finishes])
            history.extend((day, c, f, finish == 1) for c, f, finish in group[['_corner','_finish','finish_position']].itertuples(index=False, name=None))
    return data.drop(columns=['_corner', '_finish'])


def race_metrics(frame, scores):
    out = frame[['race_id', 'race_date', 'finish_position']].copy()
    out['score'] = scores
    out['prob'] = out.score / out.groupby('race_id').score.transform('sum').clip(lower=1e-12)
    out['brier'] = (out.prob-out.finish_position.eq(1).astype(int))**2
    out['rank'] = out.groupby('race_id').score.rank(method='first', ascending=False)
    winner = out.loc[out.finish_position.eq(1)].copy()
    winner['loss'] = -np.log(winner.prob.clip(lower=1e-12))
    winner['hit'] = winner['rank'].eq(1).astype(float)
    winner['brier'] = winner.race_id.map(out.groupby('race_id').brier.sum())
    return winner[['race_id', 'race_date', 'loss', 'hit', 'brier']].reset_index(drop=True)


def fit(train, c, extra):
    columns = NUM + (EXTRA if extra else [])
    pre = ColumnTransformer([
        ('cat', OneHotEncoder(handle_unknown='ignore'), CAT),
        ('num', make_pipeline(SimpleImputer(strategy='median', keep_empty_features=True), StandardScaler()), columns),
    ])
    model = make_pipeline(pre, LogisticRegression(C=c, max_iter=500, solver='lbfgs', random_state=22))
    return model.fit(train[CAT+columns], train.finish_position.eq(1).astype(int))


def summary(metrics):
    return {'races': len(metrics), 'winner_logloss': float(metrics.loss.mean()), 'top1_rate': float(metrics.hit.mean()), 'race_brier': float(metrics.brier.mean())}


def run(history_path, measurement_path, out):
    data = pd.read_parquet(history_path)
    data['race_date'] = pd.to_datetime(data.race_date).dt.strftime('%Y-%m-%d')
    data = data.drop_duplicates(['race_id', 'horse_number'])
    data = history_features(data)
    measurements = pd.DataFrame(json.loads(measurement_path.read_text()))
    target = data.loc[data.surface.eq('芝')].copy()
    matched = target.merge(measurements, left_on=['racecourse','race_date'], right_on=['venue','date'], how='left', validate='many_to_one')
    source_matches = matched.loc[matched.cushion.notna()]
    eligible = source_matches.loc[source_matches.finish_position.notna()].copy()
    eligible = eligible.loc[eligible.groupby('race_id').finish_position.transform(lambda s: s.eq(1).sum()).eq(1)]
    if eligible.empty: raise ValueError('No turf races with valid cushion measurements')
    eligible['distance_band'] = (eligible.distance_m//200).astype('Int64').astype(str)
    eligible['month'] = eligible.race_date.str[5:7]
    eligible['gate_fraction'] = pd.to_numeric(eligible.horse_number, errors='coerce') / eligible.field_size
    eligible['age_value'] = pd.to_numeric(eligible.age, errors='coerce')
    eligible['weight_value'] = pd.to_numeric(eligible.weight_carried, errors='coerce')
    eligible['cushion_front'] = eligible.cushion * eligible.prior_style.eq('front')
    eligible['cushion_rear'] = eligible.cushion * eligible.prior_style.eq('rear')
    for name in CAT: eligible[name] = eligible[name].fillna('unknown').astype(str)
    eligible['period'] = np.where(eligible.race_date.lt('2025-01-01'), 'train', np.where(eligible.race_date.lt('2026-01-01'), 'validation2025', 'audit2026'))
    eligible['cushion_band'] = pd.cut(eligible.cushion, [-np.inf,7,8,10,12,np.inf], right=False, labels=['<7','7–8','8–10','10–12','>=12'])
    groups = []
    for keys, part in eligible.groupby(['period','racecourse','cushion_band','prior_style'], observed=True):
        groups.append({'period':str(keys[0]),'venue':str(keys[1]),'cushion_band':str(keys[2]),'prior_style':str(keys[3]),'starts':len(part),'days':part.race_date.nunique(),'wins':int(part.finish_position.eq(1).sum()),'win_rate':float(part.finish_position.eq(1).mean()),'top3_rate':float(part.finish_position.le(3).mean())})
    report = {'status':'research-only','production_applied':False,'history_races':data.race_id.nunique(),'turf_races':target.race_id.nunique(),'cushion_matched_races':source_matches.race_id.nunique(),'cushion_matched_days':source_matches[['racecourse','race_date']].drop_duplicates().shape[0],'eligible_races':eligible.race_id.nunique(),'from':eligible.race_date.min(),'through':eligible.race_date.max(),'groups':groups,'comparison':{}}
    train = eligible.loc[eligible.period.eq('train')]
    validation = eligible.loc[eligible.period.eq('validation2025')]
    audit = eligible.loc[eligible.period.eq('audit2026')]
    paired = {}
    if min(train.race_id.nunique(),validation.race_id.nunique(),audit.race_id.nunique()) >= 100:
        for name, extra in [('baseline',False),('with_cushion',True)]:
            candidates=[]
            for c in (0.05,0.5,5):
                model=fit(train,c,extra)
                metrics=race_metrics(validation,model.predict_proba(validation)[:,1])
                candidates.append((float(metrics.loss.mean()),c,model,metrics))
            _,c,model,vm=min(candidates,key=lambda v:v[0])
            am=race_metrics(audit,model.predict_proba(audit)[:,1]);paired[name]=am
            report['comparison'][name]={'selected_C':c,'validation2025':summary(vm),'audit2026':summary(am)}
        diff=paired['with_cushion'].merge(paired['baseline'],on=['race_id','race_date'],suffixes=('_with','_base'))
        report['audit_delta']={'winner_logloss':float((diff.loss_with-diff.loss_base).mean()),'top1_rate':float((diff.hit_with-diff.hit_base).mean()),'race_brier':float((diff.brier_with-diff.brier_base).mean())}
        daily=diff.assign(delta=diff.loss_with-diff.loss_base).groupby('race_date').agg(total=('delta','sum'),n=('delta','size'))
        rng=np.random.default_rng(22);values=daily.to_numpy();boots=[]
        for _ in range(1000):
            sample=values[rng.integers(0,len(values),len(values))];boots.append(sample[:,0].sum()/sample[:,1].sum())
        report['audit_delta']['logloss_day_bootstrap95']=[float(v) for v in np.quantile(boots,[.025,.975])]
    else:
        report['comparison_reason']='時系列分割の各期間に100レース以上が必要'
    report['limitations']=['過去PDFの発走前公開履歴は未確認。事後の馬場状態・頭数も含むため発走前バックテストではない','基礎モデルとクッション値追加の研究比較。レイン本体の改善率ではない','当日の通過順や結果は入力にせず、前日以前の直近5走・180日以内だけから履歴を算出','学習は2024年まで、係数選択は2025年、2026年は固定監査','欠測日を補完せず、PDFの不正な数値を推測修正しない','相対スコアのレース内正規化。校正済みの的中確率として表示しない','砂厚・地方の馬場指標は芝のクッション値と混合しない']
    out.mkdir(parents=True,exist_ok=True)
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    eligible.drop(columns=['source_line'],errors='ignore').to_parquet(out/'jra-cushion-joined.parquet',index=False)
    compact={k:v for k,v in report.items() if k!='groups'}
    (out/'summary.md').write_text('# JRAクッション値研究\n\n```json\n'+json.dumps(compact,ensure_ascii=False,indent=2)+'\n```\n')
    print(json.dumps(compact,ensure_ascii=False),flush=True)
    return report


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--history',type=Path,required=True);p.add_argument('--measurements',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();run(a.history,a.measurements,a.output)
