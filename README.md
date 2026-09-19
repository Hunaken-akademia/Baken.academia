# 馬券アカデミア — 学習基盤

中央競馬のレースデータから、各出走馬の勝率を時系列で学習・評価するための基盤です。

## 現在の状態

- データ取得元に依存しないCSV入力
- 未来情報の混入（データリーク）を検査
- 日付順の train / validation / test 分割
- LightGBMによる勝率学習
- 馬・騎手・厩舎・馬場・距離・競馬場別の過去成績を、予測日より前だけで集計
- 近5走、休養間隔、距離変更、同一馬場・同一競馬場継続を特徴量化
- レース単位の確率正規化
- Log Loss、Brier Score、AUC、1着馬的中率を保存
- 学習は手動実行のみ（クラウド費用の暴走防止）

### 初回JRA実データ評価（history-v2）

- 対象: 2019-01-05〜2026-09-13、26,675レース
- テスト: 2025-03-01〜2026-09-13、5,411レース
- 1着最上位的中率: 24.23%
- 上位3頭内に勝ち馬: 54.06%
- AUC: 0.7582

これは勝ち馬順位モデルの評価であり、馬券回収率ではありません。オッズ・払戻を用いた
期待値モデルは別レイヤーで検証し、未来情報を勝率モデルの特徴量へ混入させません。

未許諾サイトからのスクレイピング処理は含めていません。利用権を確認できたCSVを `data/raw/races.csv` に配置します。

JRAから自動取得・保存・機械学習・加工結果の公開について許可を得た運営者向けに、
低負荷の公式サイト取得処理も用意しています。並列アクセスは行わず、既定で各リクエストの
間に3〜4秒の待機を入れ、取得済みページはキャッシュして再取得しません。

## 入力CSV

1行を「1レースに出走した1頭」とし、最低限、次の列が必要です。

| 列 | 内容 | 例 |
|---|---|---|
| `race_id` | レース固有ID | `202601050811` |
| `race_date` | 開催日 | `2026-01-05` |
| `horse_id` | 馬ID | `horse_123` |
| `finish_position` | 確定着順 | `1` |
| `racecourse` | 競馬場 | `中山` |
| `surface` | 芝・ダート・障害 | `芝` |
| `distance_m` | 距離 | `1600` |
| `horse_number` | 馬番 | `7` |
| `gate` | 枠番 | `4` |
| `age` | 馬齢 | `4` |
| `sex` | 性別 | `牡` |
| `weight_carried` | 斤量 | `57.0` |

`jockey_id`、`trainer_id`、`going`、`race_class`、`horse_weight`、`horse_weight_change` は任意ですが、あるほど特徴量が増えます。

## 実行

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
python -m baken_academia.train --input data/raw/races.csv --output artifacts/latest
```

日本語列名、CP932、ZIP形式の元データは、先に標準化します。

```bash
python -m baken_academia.ingest \
  --input /path/to/download.zip \
  --output data/processed/races.parquet \
  --source-name "契約したデータ提供元" \
  --license-confirmed

python -m baken_academia.train \
  --input data/processed/races.parquet \
  --output artifacts/latest
```

### JRA公式データのバックフィル

まず1開催場・1日だけを取得して構造を確認します。

```bash
python -m baken_academia.jra_backfill \
  --start-date 2026-09-13 \
  --end-date 2026-09-13 \
  --output data/raw/jra/races-test.parquet \
  --permission-confirmed \
  --max-events 1
```

過去8年分（2019年から2026年）を取得する場合は次のとおりです。

```bash
python -m baken_academia.jra_backfill \
  --start-date 2019-01-01 \
  --end-date 2026-09-18 \
  --output data/raw/jra/races-2019-2026.parquet \
  --permission-confirmed
```

処理は開催場・日単位で `data/raw/jra/events/` に保存されます。中断後に同じコマンドを
実行すると完了済みの日を飛ばして再開します。`--min-delay` は2秒未満に設定できません。
同着レースは原本に保持して `is_dead_heat` を付け、1着1頭を前提とする現行モデルの
学習時だけ除外します。

取り込み時に `races.provenance.json` と `races.audit.json` が作られ、原本ハッシュ、取得元、対象期間、レース数、欠損率を確認できます。`--license-confirmed` がないデータは取り込みません。

デフォルトでは、最新20%の日付をテスト、その直前20%を検証、残り60%を学習に使います。同一日の行が別期間へ分裂することはありません。

## 重要な設計方針

- `finish_position` は正解ラベル専用で、特徴量には入りません。
- 払戻、確定オッズ、上がり順位など結果確定後にしか分からない列は拒否します。
- `odds` と `popularity` は入力に存在しても既定では学習に使いません。
- 生データ、モデル、予測ファイルはGitへ保存しません。
- JRA取得は単一接続・逐次処理とし、429/5xx時は指数バックオフします。
- 最初は7〜8年分を保管し、原則5年学習＋直近期間検証を想定します。

## 次に必要なもの

### NAR公式データの低負荷取得

NARから許諾を得た運用者向けに、月単位・完全逐次・3〜4秒間隔で取得するバックフィルを用意しています。

```bash
python -m baken_academia.nar_backfill --year 2019 --month 1 \
  --output data/raw/nar/nar-2019-01.parquet \
  --permission-confirmed --continue-on-error
```

過去分は月間日程から開催日とレース結果をたどり、レース単位のチェックポイントと監査JSONを残します。並列取得は行いません。

利用条件を確認できる過去レースCSVです。列名が異なる場合は、元データを変更せず変換アダプターを追加します。
