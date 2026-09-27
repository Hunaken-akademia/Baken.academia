#!/usr/bin/env bash
set -Eeuo pipefail
: "${ARCHIVE_OBJECT_PATH:?}"
: "${SUPABASE_BROKER_URL:?}"
: "${GITHUB_OUTPUT:?}"
manifest_path="${ARCHIVE_OBJECT_PATH%.tar.gz}.manifest.json"
oidc_token="$(curl --fail --silent --show-error --retry 3 -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=rein-supabase-archive-v1" | jq -er '.value')"
broker() {
  curl --fail-with-body --silent --show-error --retry 3 -X POST "$SUPABASE_BROKER_URL" -H "Authorization: Bearer ${oidc_token}" -H 'Content-Type: application/json' --data "$(jq -nc --arg a "$1" --arg p "$2" '{action:$a,path:$p}')"
}
complete=false
if [[ "$(broker exists "$ARCHIVE_OBJECT_PATH" | jq -r '.exists')" == true && "$(broker exists "$manifest_path" | jq -r '.exists')" == true ]]; then
  url="$(broker sign-download "$manifest_path" | jq -er '.signed_url')"
  manifest="$(curl --fail --silent --show-error --retry 3 "$url")"
  # JRA v1 could miss same-day 00 navigation; recapture those once. NAR has no
  # corresponding parser change, so its already verified archives remain reusable.
  if jq -e --arg dataset "${DATASET}" '.verified == true and ($dataset != "jra" or (.daily_capture_schema // 1) >= 2)' <<<"${manifest}" >/dev/null; then complete=true; fi
fi
printf 'exists=%s\n' "$complete" >> "$GITHUB_OUTPUT"
printf 'Daily archive reusable: %s (%s)\n' "$complete" "$ARCHIVE_OBJECT_PATH"
