# REIN Campfire member import

The member import page is available at `/admin/members` after signing in with an administrator Google account.

## Required Vercel environment variables

Set these server-side variables for the `rein-web` Vercel project:

- `REIN_ADMIN_EMAILS`: comma, semicolon, or newline separated Google login email addresses allowed to import members.
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`: a server-side Supabase secret key. Never expose either variable with a `NEXT_PUBLIC_` prefix.

Redeploy after setting the variables. The admin page is hidden from accounts outside the allowlist. The API verifies the signed Supabase claims again, checks same-origin requests, and requires the server-only database key before writing.

## Import behavior

1. Download the current Campfire member list as CSV.
2. Select it at `/admin/members` and choose **内容を確認**.
3. Confirm the detected plan and status totals, then choose **会員情報を反映**.

The parser supports UTF-8 and Shift_JIS CSV, quoted commas, and common Japanese/English column names. It matches users by normalized email and maps REIN 地方競馬, REIN 中央競馬, and REIN オールプラン to `nar`, `jra`, and `all`.

Rows without a status column are treated as active because the upload is assumed to be Campfire's current member list. When a status column exists, recognizable active, paused, and cancelled states are mapped explicitly. Unknown statuses, unrecognized plans, invalid emails, and duplicate emails stop the whole import.

The uploaded file is parsed in memory and is not stored. Existing members omitted from the CSV are left unchanged; rows explicitly marked as cancelled are blocked immediately. Review the displayed counts before applying a file.
