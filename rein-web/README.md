# REIN web

馬券アカデミアの履歴データを使う競馬予想Webアプリです。

## 画面フロー

1. 当日の開催場を選ぶ
2. 1R〜12Rからレースを選ぶ
3. 全頭評価と8券種の本線・対抗・穴を確認する

レースIDの手入力は不要です。開催場とレース一覧は当日のJRA開催情報から取得します。

## ローカル起動

`data/history-profile.json.gz` を配置してから実行します。

```bash
npm install
npm run dev
```

## 履歴データ

`history-profile.json.gz` はリポジトリの `rein-history-profile.yml` で生成します。Web CIは生成済みのActions成果物を取得してビルドします。

