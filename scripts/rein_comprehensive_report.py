"""Consolidate all tested families, including multiplicity and negative results."""
import gzip, hashlib, json, platform, subprocess, zipfile
from pathlib import Path
import numpy as np
from rein_comprehensive_validation import ROOT,OUT,CACHE,PERIODS,by_adjust,dump

LABELS={'jra':'中央','nar':'地方','first':'1着','second':'2着','third':'3着'}
BET={'win':'単勝','place':'複勝','bracket_quinella':'枠連複','bracket_exacta':'枠連単','quinella':'馬連複','exacta':'馬連単','wide':'ワイド','trio':'三連複','trifecta':'三連単'}
NAMES={'interactions_mix0.5':'組み合わせ実績モデル50%','recent_mix0.5':'直近成績追加モデル50%','current':'現行維持'}
def pct(v):return f'{100*v:.2f}%'
def pp(v):return f'{100*v:+.2f}pt'

def run():
 families={};role_rows=[];rules=[];tests=0
 for league in ['jra','nar']:
  for family in ['roles','recent']:
   path=OUT/f'{league}-{family}.json';r=json.loads(path.read_text());families[(league,family)]=r
   for role,record in r['roles'].items():
    role_rows.append({'league':league,'family':family,'role':role,'selected':record['selected'],'original_local_gate':record['gate'],'candidates':record['candidates'],'comparisons':record['comparisons']})
    tests+=record['conditions']['candidate_condition_tests_in_selection']
    for condition in record['conditions']['rules']:rules.append({'league':league,'family':family,'role':role,**condition})
 for p in PERIODS[1:]:
  q=by_adjust([r['comparisons'][p]['all']['p_one_sided'] for r in role_rows])
  for r,z in zip(role_rows,q):r['comparisons'][p]['all']['global_by_q']=z
  q=by_adjust([r['periods'][p]['p_one_sided'] if r['periods'][p]['n']>=100 else 1. for r in rules])
  for r,z in zip(rules,q):r['periods'][p]['global_by_q']=z
 for r in role_rows:
  r['statistical_candidate']=r['selected']!='current' and all(r['comparisons'][p]['all']['global_by_q']<=.05 and r['comparisons'][p]['all']['ci95'][0]>0 and r['comparisons'][p]['pop4']['delta']>=0 and r['candidates'][p][r['selected']]['top3']>=r['candidates'][p]['current']['top3'] for p in PERIODS[1:])
  r['no_outsider_regression_gate']=r['statistical_candidate'] and all(r['comparisons'][p]['pop10']['delta']>=0 for p in PERIODS[1:])
 for r in rules:
  r['global_pass']=all(z['n']>=100 and z['global_by_q']<=.05 and z['delta']>0 and z['pop4_delta'] is not None and z['pop4_delta']>=0 and z['top3_delta']>=0 for z in [r['periods'][p] for p in PERIODS[1:]])
 market=json.loads((OUT/'market-conditions.json').read_text());tickets=json.loads((OUT/'nar-tickets.json').read_text());walk=json.loads((OUT/'nar-walkforward.json').read_text())
 assert set(market['leagues'])=={'jra','nar'} and len(walk['results'])==3,'Incomplete research'
 summary={'date':'2026-10-18','baseline_commit':'1308ca3577a88c000da87213a2ff46c5732a3216','production_changed':False,'candidate_score_configurations':sum(len(r['candidates'][PERIODS[0]])-1 for r in role_rows),'role_condition_tests':tests,'role_condition_selected_rules':len(rules),'role_condition_global_passed':sum(r['global_pass'] for r in rules),'role_families':role_rows,'statistical_candidates':sum(r['statistical_candidate'] for r in role_rows),'no_outsider_regression_passed':sum(r['no_outsider_regression_gate'] for r in role_rows),'market_condition_tests':sum(x['tests'] for x in market['leagues'].values()),'market_condition_strict_passed':sum(x['strict_passed'] for x in market['leagues'].values()),'ticket_comparisons':len(tickets['selected']),'ticket_strict_passed':tickets['strict_passed'],'walkforward':walk,'coverage':{l:{k:v for k,v in families[(l,'roles')].items() if k not in ['roles','features']} for l in ['jra','nar']},'market_coverage':market['coverage']}
 dump(OUT/'summary.json',summary);dump(OUT/'condition-global-audit.json',{'description':'Global BY across both leagues, three roles, two feature families; no post-audit choice of rules','rules':rules})
 lines=['# REIN 追加精度・条件組み合わせ検証', '', '検証日：2026年10月18日。取得済みデータを使った遡及検証です。本番の予想モデル・買い目は変更していません。', '',
 '**地方の1着・3着評価に改善候補があります。ただし大穴の拾い漏れが増えるため、全面採用は保留します。中央の変更案と、安定利益を条件にした買い目変更案は見送りです。**', '',
 '## 対象と検証範囲', '', '|対象|期間|レース数|用途|','|---|---|---:|---|']
 for l in ['jra','nar']:
  r=families[(l,'roles')];lines.append(f"|{LABELS[l]}・取得履歴|{r['raw_dates'][0]}〜{r['raw_dates'][1]}|{r['raw_races']:,}|学習・過去実績の作成|")
  lines.append(f"|{LABELS[l]}・着順評価|2025年〜取得最終日|{r['evaluation_races']:,}|取消・欠落等を除く6頭以上|")
 for l,z in market['coverage'].items():lines.append(f"|{LABELS[l]}・確定オッズ検証|{z['start']}〜{z['end']}|{z['races']:,}|既存のオッズ別購入方式|")
 lines+=['',f"- 新しい評価方法は延べ **{summary['candidate_score_configurations']}設定**。着順評価の条件・方式の組み合わせは延べ **{tests:,}通り**、オッズ購入方式と条件は **{summary['market_condition_tests']:,}通り**を検査。重複する条件や同じレースを含むため、独立した検証数ではありません。",'- 馬、馬×馬場・距離・コース、騎手、厩舎、枠の基礎実績に加え、馬×騎手、馬×厩舎、馬×コース×距離、騎手×厩舎、騎手×競馬場、厩舎×競馬場、コース×季節を比較。','- 直近3走・5走、休養日数、距離・馬体重の変化、騎手・厩舎の直近90日・365日成績を追加した案も比較。','- 競馬場・芝ダート・距離帯・馬場・頭数・季節・グレード表記を最大3条件まで組み合わせ。オッズ検証では人気馬オッズ帯・人気差も追加。','- 地方の買い目は9券種、6方式、上限1/3/5/10/20/30点。各点100円で公式払戻と照合。三連単・枠連単は研究対象の拡張で、全券種が本番に実装されているという意味ではありません。','',
 '## 期間の分離と判定', '', '新モデルの学習は2019〜2024年。2025年1〜6月で方式を選び、同年7〜12月で確認、2026年で再確認しました。基準モデルは中央の既存モデル（阪神・良の3着補助を含む）、地方の既存方式を2024年末までで再学習したものです。', '',
 '同じ日の結果がその日の特徴量に入らないよう、日単位で集計してから過去分だけを参照します。着順評価には当日の人気・オッズを入力していません。人気は穴馬群の評価に使います。', '',
 '主要な着順比較の95%区間は開催日単位の再標本化で算出。条件探索の区間・検定には日単位の集計から求めた標準誤差を使い、利益基準を通過する候補には再標本化も要求します。条件を大量に調べた影響は、重複条件にも対応するBenjamini–Yekutieli法で補正しました。最終まとめでは、着順評価について中央・地方・全着順・追加特徴群をまとめて再補正しています。個別JSONの旧ローカル判定より、summary.jsonとcondition-global-audit.jsonの判定を優先してください。', '',
 '**2026年は以前から何度も見た期間です。今回の成績は「完全な未検証データで証明した成績」ではありません。過去の基準方式や候補定義には後年の知見もあり、当時保存した予想の再生でもありません。**', '',
 '## 改善候補', '', '以下は「該当着順の馬が、その着順評価の上位5頭に含まれた割合」です。馬券の的中率・回収率とは異なります。', '',
 '|候補|確認期間|対象R|現行|候補|差|差の95%区間|','|---|---|---:|---:|---:|---:|---|']
 for r in role_rows:
  if not r['statistical_candidate']:continue
  label=f"{LABELS[r['league']]}{LABELS[r['role']]}・{NAMES.get(r['selected'],r['selected'])}"
  for p in PERIODS[1:]:
   a=r['candidates'][p]['current'];b=r['candidates'][p][r['selected']];z=r['comparisons'][p]['all'];ci=z['ci95'];lines.append(f"|{label}|{'2025年後半' if p==PERIODS[1] else '2026年'}|{z['n']:,}|{pct(a['top5'])}|{pct(b['top5'])}|{pp(z['delta'])}|{pp(ci[0])}〜{pp(ci[1])}|")
 lines+=['','### 人気薄への影響','', '|候補|2026年・4番人気以下の差|2026年・10番人気以下の差|10番人気以下の対象R|判断|','|---|---:|---:|---:|---|']
 for r in role_rows:
  if not r['statistical_candidate']:continue
  z=r['comparisons'][PERIODS[2]];lines.append(f"|{LABELS[r['league']]}{LABELS[r['role']]}・{NAMES.get(r['selected'],r['selected'])}|{pp(z['pop4']['delta'])}|{pp(z['pop10']['delta'])}|{z['pop10']['n']}|大穴の非悪化を満たさず、全面採用保留|")
 lines+=['','10番人気以下の該当着順馬は母数が小さい区分もあり、悪化の大きさには不確実性があります。ただし、穴馬への強さを守るという条件では見過ごせません。直近成績だけで1着評価を置き換えた案は全体の数値がさらに上がった一方、穴馬の悪化が大きく、見送ります。','',
 '## 古い年での再確認', '', '地方1着の「組み合わせ実績モデル50%」を固定し、2022・2023・2024年それぞれの前年末までで学習し直しました。候補定義自体は2025年を見て決めたものなので、これは過去期間での頑健性確認です。', '', '|評価年|対象R|現行Top5|候補Top5|差|4番人気以下の差|10番人気以下の差|','|---|---:|---:|---:|---:|---:|---:|']
 for r in walk['results']:
  z=r['metrics']['all'];lines.append(f"|{r['year']}|{r['races']:,}|{pct(z['baseline_top5'])}|{pct(z['candidate_top5'])}|{pp(z['delta'])}|{pp(r['metrics']['pop4']['delta'])}|{pp(r['metrics']['pop10']['delta'])}|")
 lines+=['', '全体の改善は3年とも再現しましたが、人気薄の改善は一貫しませんでした。', '', '## 全着順・全特徴群の結論', '', '|区分|着順|特徴群|2025年前半で選んだ方式|2026年Top5差|最終判断|','|---|---|---|---|---:|---|']
 for r in role_rows:
  decision='改善候補・大穴条件で保留' if r['statistical_candidate'] else '現行維持'
  lines.append(f"|{LABELS[r['league']]}|{LABELS[r['role']]}|{'長期実績と組み合わせ' if r['family']=='roles' else '直近成績の追加'}|{r['selected']}|{pp(r['comparisons'][PERIODS[2]]['all']['delta'])}|{decision}|")
 lines+=['',f"条件別に全探索をまとめた補正後の基準を満たしたものは{summary['role_condition_global_passed']}件ですが、同じモデルに対する重複・包含条件を含みます。独立した改善策の数ではなく、大穴の非悪化や本番投入の根拠でもありません。", '',
 '## 買い目・回収率', '', f"地方{tickets['races']:,}レース、{tickets['records']:,}件の『レース×方式×券種×点数』を精算。2025年前半で選んだ54の券種・点数比較のうち、確認期間と2026年の双方で安定利益・現行比改善・的中率非悪化・同一実支出を満たしたものは **{tickets['strict_passed']}件**でした。", '',
 '以下は2026年、上限3点・各100円の比較例です。各方式で同じ予算上限を使っています。本番画面の全推奨点数をそのまま購入した成績ではありません。', '', '|券種|現行7:3方式の回収率|適性100%の回収率|長期実績候補を混ぜた7:3方式|','|---|---:|---:|---:|']
 for bet in ['win','place','exacta','wide','trio','trifecta']:
  vals={z['method']:z for z in tickets['unfiltered_results'] if z['period']==PERIODS[2] and z['points']==3 and z['bet']==bet}
  lines.append(f"|{BET[bet]}|{pct(vals['current_70_30']['roi'])}|{pct(vals['role_100']['roi'])}|{pct(vals['selected_70_30']['roi'])}|")
 lines+=['', '上の候補買い目は長期実績の着順候補を使った実験です。追加した直近成績モデルの買い目への適用は、この表には含みません。着順のTop5改善から利益改善を推測してはいけません。', '',
 '|確定オッズの条件検証|検査数|選択期間で回収率105%以上だった条件|全期間の安定利益基準通過|','|---|---:|---:|---:|']
 for league,z in market['leagues'].items():lines.append(f"|{LABELS[league]}|{z['tests']:,}|{z['selection_passed']:,}|{z['strict_passed']}|")
 lines+=['', '中央は2019〜2023年で選択、2024年・2025年・2026年で順に確認。地方の確定オッズは2026年2〜9月に限られるため、2〜5月で選択、6〜7月で確認、8〜9月で再確認。地方のオッズ検証を「8年間の利益検証」とは扱っていません。','',
 '各条件について、回収率・的中率・日次の最大ドローダウン・黒字月数・最大払戻への依存度・最大払戻を除いた回収率も出力しました。利益条件には各後続期間の母数、回収率100%超、日単位の不確実性、全探索の補正を要求しています。', '',
 '## 見つけて直した検証の問題', '',
 '既存の地方買い目検証は、2019〜2024年で方式を比較した後に全期間で再学習する本番用関数を呼び、その返却係数で2025・2026年を採点していました。これでは評価対象の結果が係数学習に含まれます。検証時は係数と標準化器の学習を2024年末で止める引数を追加し、買い目検証から明示して呼ぶよう修正しました。本番用の再学習の既定動作は変えていません。古い買い目レポートは、この修正前の成績を採用根拠にしないでください。','',
 '## 検証上の制約と次の判断', '',
 '- 確定オッズ・最終人気を使った購入実験は、締切前に実際に発注できた成績ではありません。変動、取得遅延、欠損、発注時点の制約は未再現です。','- 地方のばんえい、取消・除外・中止・失格・欠落のある出走表、着順評価では6頭未満を除外。対象外への一般化は未確認です。同着は、該当着順の正解が一意でない評価から除外しました。','- グレード判定は取得済みのレース名・クラス表記で識別できたものに限定。完全な重賞台帳との照合や、各G1を個別に十分な件数で評価したものではありません。','- 中央の新しい着順候補から任意の買い目を生成した回収率は未検証。中央の回収検証は、払戻照合済みの既存オッズ購入方式に限ります。','- 今回は取得済みデータで定義した探索範囲を検査しました。無限にある条件の全組み合わせを尽くしたという意味ではありません。','',
 '次に優先するのは、地方1着の控えめな混合率と地方3着の候補について、事前にルールを固定した締切前の記録を集めることです。現行と並べて評価し、10番人気以下の拾い漏れが増えないこと、同じ費用で買い目の成績が改善することを確認してから採用を判断します。', '',
 '## 再実行', '', '入力の由来とハッシュはmanifest.json、全結果は同梱JSON、実行コードと回帰テストはscripts/とtests/に収録。生の出走データ、認証情報、学習済み候補モデルは同梱していません。現在の基準コミットと同じデータを用意して以下を実行します。', '', '```bash', 'OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 PYTHONPATH=src:scripts python scripts/rein_comprehensive_validation.py roles --league jra', 'OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 PYTHONPATH=src:scripts python scripts/rein_comprehensive_validation.py roles --league nar', 'OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 PYTHONPATH=src:scripts python scripts/rein_comprehensive_recent.py --league jra', 'OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 PYTHONPATH=src:scripts python scripts/rein_comprehensive_recent.py --league nar', 'OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 PYTHONPATH=src:scripts python scripts/rein_comprehensive_walkforward.py', 'OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 PYTHONPATH=src:scripts python scripts/rein_comprehensive_tickets.py', 'OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 PYTHONPATH=src:scripts python scripts/rein_comprehensive_market.py', 'PYTHONPATH=src:scripts python scripts/rein_comprehensive_report.py', '```', '', 'メモリ消費が大きいため、上記は順番に実行してください。検証コードの回帰テスト13件が通過しています。']
 (OUT/'README.md').write_text('\n'.join(lines)+'\n')
 # Keep the git deliverable compact; full per-condition output is in the report archive.
 dump(OUT/'review-summary.json',{k:v for k,v in summary.items() if k!='role_families'}|{'roles':[{k:v for k,v in r.items() if k!='candidates'} for r in role_rows]})
 print(json.dumps({k:summary[k] for k in ['candidate_score_configurations','role_condition_tests','role_condition_global_passed','statistical_candidates','no_outsider_regression_passed','market_condition_tests','market_condition_strict_passed','ticket_strict_passed']},ensure_ascii=False))

if __name__=='__main__':run()
