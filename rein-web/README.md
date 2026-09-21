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

`history-profile.json.gz` はリポジトリの `rein-history-profile.yml` で生成します。過去データの生成・モデル再学習はGitHub Actionsで明示的に実行し、本番WebはVercelのGit連携で`main`から自動デプロイします。

VercelのGitビルドでは、固定した`CRON_SECRET`を使い、直前の本番デプロイが持つ認証付き内部エンドポイントから履歴プロファイルを取得します。これによりライセンス対象の履歴ファイルを公開Gitへ置かず、Actionsの稼働状況にも依存せずに同じ評価データを次のデプロイへ引き継ぎます。

## 本番運用

- `main`へのpush: Vercel Git連携がビルド、テスト、本番デプロイを実行
- `/api/cron/rein-live`: Vercel CronがJST 8:40〜17:00の間だけ10分ごとに起動し、発走60分前からオッズ・馬場状態を更新。馬体重は取得後に固定
- 過去8年の取得・モデル学習: GitHub Actionsを手動または専用トリガーで実行
- `.github/workflows/rein-web-ci.yml`: Git連携障害時だけ使う手動の緊急デプロイ
- GitHub ActionsからSupabaseへの同期: バックフィル完了時の`workflow_run`または手動実行のみ

Vercel本番環境の`CRON_SECRET`は固定値として管理します。デプロイごとに変更すると実行中のCronと内部更新要求がずれるため、自動ローテーションしません。
