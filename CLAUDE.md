# CLAUDE.md

## アップデートを出したら X でも告知する（自動投稿）
- REIN の利用者向けアップデート（新機能・改善・お知らせ）を出したら、**同じ作業の中で** Supabase（WAKE と同じプロジェクト `dcewdzagnomcnvteokwj`）の `x_update_queue` に告知を1件入れる。運営の確認は不要（完全自動の方針）。WAKE 側の cron（newhunaken456 の `api/cron-x-updates.js`、15分ごと）が予約時刻を過ぎたものを馬券アカデミア（@bakenacademia）に投稿する。
  - `account`：`'horse'`
  - `title`：管理用の短い名前
  - `text`：「【REIN アップデート】」で始め、何ができるようになったかを1〜2文。本文だけで全角110字以内（REIN の販売ページのリンクと `#REIN #競馬` は自動で付く）。買い目や有料の中身は書かない
  - `image_url`：画面の画像があれば `rein-web/public/` に置き、`https://rein-web.vercel.app/<ファイル名>` で指定（PNG / JPEG / WebP、5MB まで）。無ければ空でよい（文字だけで出る）
  - `publish_at`：本番に反映されたあと（マージして数分後以降）の時刻
  - 例：`insert into public.x_update_queue (account,title,text,image_url,publish_at) values ('horse','新機能の名前','【REIN アップデート】…','https://rein-web.vercel.app/rein-new-feature.png', now() + interval '15 minutes');`
- 取り消すときは `status='cancelled'` にする。仕組みの詳細は newhunaken456 の `README_X_AUTO_POST.md`。
