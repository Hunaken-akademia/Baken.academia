#!/usr/bin/env bash
set -Eeuo pipefail

origin="https://rein-web.vercel.app"
today="$(TZ=Asia/Tokyo date +%F)"
default_start="$(TZ=Asia/Tokyo date -d '365 days ago' +%F)"
start="${START_DATE:-$default_start}"
end="${END_DATE:-$(TZ=Asia/Tokyo date -d yesterday +%F)}"

valid_date() { [[ "$1" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] && [[ "$(date -d "$1" +%F 2>/dev/null)" == "$1" ]]; }
valid_date "$start" && valid_date "$end" || { echo "::error::Dates must use YYYY-MM-DD"; exit 2; }
[[ "$start" < "$end" || "$start" == "$end" ]] || { echo "::error::START_DATE must be on or before END_DATE"; exit 2; }
oldest="$(TZ=Asia/Tokyo date -d '365 days ago' +%F)"
[[ ! "$start" < "$oldest" && "$end" < "$today" ]] || { echo "::error::Backfill dates must be within the last 365 completed days"; exit 2; }

get_token() {
  curl --fail --silent --show-error --retry 3 \
    -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=rein-live-capture-v1" | jq -er '.value'
}

for area in jra nar; do
  current="$start"
  while [[ "$current" < "$end" || "$current" == "$end" ]]; do
    echo "Backfill $area $current"
    complete=false
    for attempt in {1..40}; do
      token="$(get_token)"
      response_file="$(mktemp)"
      status="$(curl --silent --show-error --max-time 310 --output "$response_file" --write-out '%{http_code}' \
        -H "Authorization: Bearer $token" \
        "$origin/api/cron/rein-live?date=$current&area=$area")"
      unset token
      jq -c '{league,date,planned,attempted,updated,held,incomplete,failed,deferred,remaining,error}' "$response_file" 2>/dev/null || true

      if [[ "$status" == "202" || "$status" =~ ^(401|502|503)$ ]]; then
        rm -f "$response_file"; sleep 30; continue
      fi
      if [[ "$status" != "200" ]]; then
        rm -f "$response_file"
        echo "::error::Backfill endpoint failed for $area $current (HTTP $status)"
        exit 1
      fi
      if [[ "$(jq -r '.league // ""' "$response_file")" != "$area" ]]; then
        rm -f "$response_file"; sleep 30; continue
      fi
      remaining="$(jq -er '.remaining' "$response_file")"
      updated="$(jq -er '.updated' "$response_file")"
      ok="$(jq -r '.ok' "$response_file")"
      rm -f "$response_file"
      if [[ "$remaining" == "0" && "$ok" == "true" ]]; then complete=true; break; fi
      if [[ "$updated" == "0" ]]; then
        echo "::error::No progress while $remaining $area races remain on $current"
        exit 1
      fi
      sleep 5
    done
    [[ "$complete" == "true" ]] || { echo "::error::Backfill still has remaining races for $area $current"; exit 1; }
    current="$(TZ=UTC date -d "$current + 1 day" +%F)"
  done
done
echo "One-year historical snapshot backfill completed: $start through $end"
