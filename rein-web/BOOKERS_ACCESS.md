# REIN BOOKERS 会員（合言葉方式）

WAKE と同じ仕組みです。BOOKERS には加入・解約を外へ知らせる仕組みが無いため、プランごとの **メンバーシップ限定記事** に毎月の合言葉を載せ、会員が REIN の `/access` 画面で入力すると利用権が付きます。

- プラン：地方競馬（nar）／中央競馬（jra）／オール（all）。合言葉もプランごとに別。
- 合言葉は毎月1日0時（日本時間）に新しくなり、利用権もその時刻に切れます（猶予なし）。続けている会員は記事で新しい合言葉を見て入れ直します。解約した人は記事を読めないので止まります。
- `/api/cron/rein-bookers-codes`（毎時3分）が今月の合言葉を作り、BOOKERS の記事本文（有料部分）を API で書き換えます。反映済みなら何もしません。
- 利用権は `rein_memberships` に会員キー `bookers:<GoogleログインのユーザーID>` で付きます。CAMPFIRE で同等以上の利用権がある人は変更しません。期限切れの CAMPFIRE 会員が合言葉を入れた場合は、その行を BOOKERS の会員キーに付け替えるので、以後の CSV 取込では上書きされません。
- 1時間に10回間違えると1時間入力できません。
- 合言葉記事の単品価格は 50,000 円（会員以外が単品で買って翌月以降も読むのを防ぐため。会員はメンバーシップで無料で読めます）。

## 表（Supabase、service_role のみ）
`rein_bookers_access_codes`（合言葉）、`rein_bookers_code_posts`（プラン→記事）、`rein_bookers_redemptions`（入力の記録）、`rein_bookers_code_attempts`（入力回数）。migration `20261120000000_rein_bookers_access_codes.sql`。

## 設定（Vercel rein-web のサーバー環境変数）
- `BOOKERS_API_TOKEN`：WAKE と同じ BOOKERS アカウントの API トークン。未設定だと合言葉は作られますが記事は書き換わりません。
- `SUPABASE_SERVICE_ROLE_KEY`（または `SUPABASE_SECRET_KEY`）、`CRON_SECRET`：既存のもの。

## 合言葉を作り直す（横流しが分かったとき）
`update public.rein_bookers_access_codes set retired_at = now() where plan = 'nar' and month = '2026-11' and retired_at is null;` のあと、次の cron（毎時3分）で新しい合言葉が作られ記事が書き換わります。すでに入力した人の利用権はそのままです。
