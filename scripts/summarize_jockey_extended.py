"""Persist compact, reviewable comparisons; never activate prediction weights."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
LABELS={'venuePop':'競馬場×芝ダート×人気帯','distancePop':'芝ダート×距離帯×人気帯','trainerPair':'騎手×厩舎','horsePair':'騎手×馬','form90':'直近90日','form180':'直近180日','venueRecent365':'直近1年の競馬場×芝ダート','distanceRecent365':'直近1年の芝ダート×距離帯','extendedCombined':'追加8条件の平均'}
lines=['# REIN 騎手補正の追加検証（2026-10-05）','','直近90・180日、直近1年の競馬場・距離、騎手と馬／厩舎の組み合わせ、同じ人気帯での条件成績、8条件平均を追加。9信号×着順別／1〜3着平均×正加点／正負補正×5強度＝各着順180候補。中央・地方で各540候補を比較し、一律補正の共通設定も確認した。','','当日・未来の結果を使わず、完成した過去日付の実績だけを集計。馬・厩舎の組み合わせは相手側の既存成績も参考に縮小し、人気帯の比較は同じ人気帯での騎手成績を基準にした。これで能力・市場評価を完全に調整できるわけではない。少数データは補正ゼロまたは縮小。','','2025年前半で候補を選択し、後半と2026年で確認。ただし後半・2026年は前の検証でも確認済みで、今回は独立した初見検証ではない。候補を増やして当たったものだけを採用すると過剰適合の危険がある。人気帯には履歴の確定人気を使用しており、実運用の発走前人気との一致は未検証。','','Top5＝実際の対象着順の馬を候補上位5頭に含めた率。「差」は補正後−現行、百分率ポイント。95%区間は日付単位で対応付きに再標本化。両確認期間の全体Top5差の区間下端が0超、人気4番以下Top5と全体Top3が悪化しないことを暫定の研究基準にする。採用には別の未来期間と配信処理の一致確認も必要。','','| 系統 | 方式 | 対象 | 選択信号 | 2025後半 差(pt) | 2026 差(pt) | 研究判定 |','|---|---|---|---|---:|---:|---|']
summary={};coverage_lines=[]
for league in ['jra','nar']:
 d=json.loads((ROOT/f'artifacts/jockey-corrections-extended/{league}-jockey-corrections.json').read_text())
 summary[league]={k:d[k] for k in ['coverage','selection','confirmation','audit','historyPolicy','signalCoverage','productionModelChanged']};summary[league]['roles']={};summary[league]['uniform']={'selected':d['uniform']['selected']}
 for family in ['roles','uniform']:
  for i,role in enumerate(['first','second','third'],1):
   v=d[family][role];a=v['comparisons']['confirmation2025H2']['all'];b=v['comparisons']['retrospective2026']['all'];name=v['selected'];group=name.split('-')[0]
   lines.append(f"| {league.upper()} | {'着順別選択' if family=='roles' else '一律'} | {i}着 | {LABELS.get(group,name)} | {a['gain']*100:+.3f} | {b['gain']*100:+.3f} | {'研究基準通過' if v['gate']=='offline_pass' else '現状維持'} |")
   summary[league][family][role]={'selected':name,'gate':v['gate'],'periods':v['periods'],'comparisons':v['comparisons']}
 coverage_lines.append(f"{league.upper()}の評価範囲：{d['coverage']['races']:,}レース、{d['coverage']['runners']:,}頭。着順が同着・欠損の場合は対象着順の率集計から除外するため、役割別の母数は異なる。signalCoverageのeligibleStartsは全履歴の集計可能出走数で、評価期間の頭数ではない。")
v=summary['nar']['roles']['first'];a=v['comparisons']['confirmation2025H2']['all'];b=v['comparisons']['retrospective2026']['all'];hole=v['comparisons']['retrospective2026']['pop4plus'];deep=v['comparisons']['retrospective2026']['pop10plus']
lines+=['',f"地方1着の競馬場×人気帯補正では、全体Top5が2025後半{a['gain']*100:+.3f}pt、2026年{b['gain']*100:+.3f}pt。しかし2026年の4番人気以下は{hole['gain']*100:+.3f}pt、10番人気以下は{deep['gain']*100:+.3f}pt（{deep['races']}レース、差引{deep['net']}件）。全体の改善だけで採用すると穴馬を拾う目的と逆になる。2026年の全体改善の95%区間も0をまたぐ。今回の追加候補はすべて現状維持。"]
lines+=['',*coverage_lines,'','中央は保存した配備モデルの予測、地方は同じ本番レシピを2024年末までで再学習した研究用比較。配備済み地方モデルの未見評価と同一ではない。モデル・本番係数は変更していない。','','一律方式は、2025年前半で選んだ共通設定を全着順へ必ず適用して集計した。特定の着順だけ現行へ戻して合算することはしていない。','','検証：同日結果の変更、未来行の追加、90日窓の期限境界、未知の馬ペア、対象着順・同着の扱い、一律設定の強制適用をテスト。']
(ROOT/'reports/jockey-correction-extended-20261005.md').write_text('\n'.join(lines)+'\n')
(ROOT/'reports/jockey-correction-extended-20261005.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print({league:{family:{role:v['gate'] for role,v in q[family].items() if isinstance(v,dict)} for family in ['roles','uniform']} for league,q in summary.items()})
