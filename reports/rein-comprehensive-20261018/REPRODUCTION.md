# 再現用入力の準備

基準リポジトリ：https://github.com/Hunaken-akademia/Baken.academia
基準コミット：1308ca3577a88c000da87213a2ff46c5732a3216

このZIPのscripts/・tests/を基準リポジトリに重ねます。必要な生データとモデルはライセンス上の取り扱いを維持し、manifest.jsonのGitHub Actions artifactから取得してください。元artifactが期限切れなら、リポジトリの収集処理で同じ期間を用意し、ハッシュ差を記録します。生データはこのZIPには含まれません。

- JRAモデル・履歴のbundleを .second-third-audit/jra/ 配下に展開（*/schema.json と */data/history.parquet を保持）。
- 地方履歴を research-input/12101739035/nar-history.parquet に配置し、.nar-dataset/nar-history.parquet から参照。
- 6つのオッズ検証artifactを research-input/<artifact_id>/ に展開。
- メタデータを research-input/11737120265/race-metadata.parquet に配置。

既存の基準予想の準備：

```python
from pathlib import Path
from rein_accuracy_experiments import jra_dataset, nar_dataset
Path('research-input/prepared').mkdir(parents=True, exist_ok=True)
for league, prepare in [('jra', jra_dataset), ('nar', nar_dataset)]:
    data, features, scores = prepare()
    for role, score in scores.items():
        data[role] = score
    data.to_parquet(f'research-input/prepared/{league}-baseline.parquet')
```

PYTHONPATH=src:scripts で実行し、その後README.mdの順番で検証します。キャッシュは今回の入力だけに対応します。入力を変えた再検証ではresearch-cache/を別の場所に退避して新規に作成してください。
