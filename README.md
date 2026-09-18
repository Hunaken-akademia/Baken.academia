# 馬券アカデミア — 学習基盤

中央競馬のレースデータから、各出走馬の勝率を時系列で学習・評価するための基盤です。

## 現在の状態

- データ取得元に依存しないCSV入力
- 未来情報の混入（データリーク）を検査
- 日付順の train / validation / test 分割
- LightGBMによる勝率学習
- レース単位の確率正規化
- Log Loss、Brier Score、AUC、1着馬的中率を保存
- 学習は手動実行のみ（クラウド費用の暴走防止）

未許諾サイトからのスクレイピング処理は含めていません。利用権を確認できたCSVを `data/raw/races.csv` に配置します。

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

デフォルトでは、最新20%の日付をテスト、その直前20%を検証、残り60%を学習に使います。同一日の行が別期間へ分裂することはありません。

## 重要な設計方針

- `finish_position` は正解ラベル専用で、特徴量には入りません。
- 払戻、確定オッズ、上がり順位など結果確定後にしか分からない列は拒否します。
- `odds` と `popularity` は入力に存在しても既定では学習に使いません。
- 生データ、モデル、予測ファイルはGitへ保存しません。
- 最初は7〜8年分を保管し、原則5年学習＋直近期間検証を想定します。

## 次に必要なもの

利用条件を確認できる過去レースCSVです。列名が異なる場合は、元データを変更せず変換アダプターを追加します。
