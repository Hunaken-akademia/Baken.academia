# REIN CAMPFIRE 会員取込

管理者が `/admin/members` で最新CSVを選択し、「内容を確認」でプラン別人数・停止日時・保護対象を確認してから反映します。確認結果は10分間有効です。ファイルや既存会員情報が変わった場合は再確認が必要です。

## 利用期間

- 地方1,000円＝nar、中央1,000円＝jra、オール1,500円＝両方。
- 退会・解約・休会・停止は最終決済月の翌月1日 **00:00 日本時間** まで利用可能。例：202609なら2026年10月1日00:00で終了します。取込時点で即停止しません。ただし過去の決済月で期限を過ぎていれば利用不可です。
- 停止日はCSVの最終決済月（YYYYMM / YYYY-MM）から算出します。日時が不明なら既存の停止予定日を使い、それもなければ全体をエラーにして反映しません。
- 同じ停止会員を再取込しても期限を延長しません。再加入した有効会員は停止予定を解除します。
- 期限は各リクエストで判定するため月初のバッチ実行は不要です。ページ・APIとも同じ判定を使います。

## CSV・照合

UTF-8 / Shift_JIS、引用符・改行に対応。WAKEと同じ備考、メンバー特典、メンバーステータス、最終決済月を認識します。Googleメール列、または備考欄のGoogleメールを優先します。備考列がない場合のみ一般メール列を使います。異なるメールが複数ある場合はエラーになります。

会員IDを優先して更新し、メール変更時はGoogle認証との紐付けを再設定します。IDがないCSVはメールをキーにするためメール変更の追跡はできません。継続した会員IDを含むCSVを使用してください。

状態列・プラン・メール・重複・停止期限の不備は全件反映を中止します。CSVにない会員は変更しません。手動登録の友人・管理者は保護し、更新対象外の人数を表示します。自動生成列 normalized_email は書き込みません。CSV本体は保存しません。

## 設定

Vercel rein-web のサーバー環境変数：
- REIN_ADMIN_EMAILS：管理者Googleメールをカンマ・セミコロン・改行で区切る。
- SUPABASE_SERVICE_ROLE_KEY または SUPABASE_SECRET_KEY。NEXT_PUBLIC_ を付けない。
- RESEND_API_KEY：有効なResend APIキー。サーバー専用に設定し、公開前にSupabase migration `20260928223902_rein_welcome_email_outbox.sql` を適用する。

設定変更後は再デプロイが必要です。APIはログイン済み署名・管理者リスト・同一オリジン・署名済み確認トークンを検証します。既存 rein_memberships テーブルとメール紐付けトリガーを使用します。

実際のCAMPFIRE書き出しファイルでの最終照合は未実施です。最新CSVをプレビューし、停止日時と人数を確認してから反映してください。過去の有効CSVを再取込すると再加入として扱われるため、必ず最新の一覧を使用してください。

## 登録完了メール（Resend）

有効会員の反映後、備考欄から取り込んだGoogleメール宛に、登録完了・プラン別の利用範囲・REINログインリンクを記載したメールを送ります。オープンチャット「馬券アカデミア」の招待リンクと参加コードも案内し、REINの意見・要望や競馬情報を交換する場として紹介します。退会・停止会員には送信しません。送信済み・失敗は `rein_welcome_email_outbox` に記録します。同じCSVを再反映すると、送信済みはスキップし、未送信・失敗分だけ再試行します。メール送信に失敗しても会員情報の反映は取り消されず、画面に件数が表示されます。
# Welcome email (Resend)

On apply, newly imported active Campfire members receive a short registration completion email at their registered Google email, with the REIN login link. The verified sender domain is `hunaken-academia.com`.

- Configure the server-side `RESEND_API_KEY` in the REIN Vercel project. Never expose it to browser code or commit the secret.
- Apply the matching Supabase migration before deploying.
- Send state is stored in `rein_welcome_email_outbox`. Reapplying the CSV skips sent email and retries pending or failed email. Email failures do not undo membership updates.
- Canceled members do not receive this welcome email.
