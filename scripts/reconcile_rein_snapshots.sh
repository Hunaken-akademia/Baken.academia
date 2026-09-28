#!/usr/bin/env bash
set -Eeuo pipefail
: "${CAPTURE_DATE:?CAPTURE_DATE is required}"
capture_area="${CAPTURE_AREA:-jra}"
[[ "${capture_area}" == "jra" || "${capture_area}" == "nar" ]]
# Only yesterday/today have an active schedule in the live app. Older manual
# recoveries still archive raw data, without generating retrospective forecasts.
today="$(TZ=Asia/Tokyo date +%F)"
yesterday="$(TZ=Asia/Tokyo date -d yesterday +%F)"
if [[ "${CAPTURE_DATE}" != "${today}" && "${CAPTURE_DATE}" != "${yesterday}" ]]; then exit 0; fi
expected_release=""
release_query=""
if [[ "${capture_area}" == "nar" && "${GITHUB_EVENT_NAME:-}" == "push" && -f .github/rein-live-release.json ]]; then
  expected_release="$(jq -er '.narRelease' .github/rein-live-release.json)"
  [[ "${expected_release}" =~ ^[a-z0-9-]+$ ]]
  release_query="&release=${expected_release}"
fi
for attempt in {1..8}; do
  oidc_token="$(curl --fail --silent --show-error --retry 3 -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=rein-live-capture-v1" | jq -er '.value')"
  response_file="$(mktemp)"
  status="$(curl --silent --show-error --max-time 300 --retry 2 --output "${response_file}" --write-out '%{http_code}' -H "Authorization: Bearer ${oidc_token}" "https://rein-web.vercel.app/api/cron/rein-live?date=${CAPTURE_DATE}&area=${capture_area}${release_query}")"
  # Logs contain counts only, never signed URLs, cookies or identity tokens.
  jq '{ok,league,narRelease,date,planned,attempted,updated,held,incomplete,failed,deferred,remaining,error}' "${response_file}"
  if [[ "${status}" == "404" ]]; then
    echo '::warning::No saved schedule for this date; raw capture remains independent.'
    rm -f "${response_file}"; exit 0
  fi
  if [[ "${status}" == "202" ]]; then rm -f "${response_file}"; sleep 30; continue; fi
  # A push can finish its lightweight archive checks before the production build
  # switches over. Retry briefly against the still-old authenticated endpoint.
  if [[ "${status}" =~ ^(401|502|503)$ ]]; then
    rm -f "${response_file}"; sleep 30; continue
  fi
  [[ "${status}" == "200" ]]
  # During rollout the old endpoint may ignore area=nar. Never mistake JRA work
  # for successful NAR warming; wait for the deployed league-aware endpoint.
  if [[ "$(jq -r '.league // ""' "${response_file}")" != "${capture_area}" ]]; then
    rm -f "${response_file}"; sleep 30; continue
  fi
  if [[ -n "${expected_release}" && "$(jq -r '.narRelease // ""' "${response_file}")" != "${expected_release}" ]]; then
    rm -f "${response_file}"; sleep 30; continue
  fi
  remaining="$(jq -er '.remaining' "${response_file}")"
  updated="$(jq -er '.updated' "${response_file}")"
  ok="$(jq -r '.ok' "${response_file}")"
  rm -f "${response_file}"
  if [[ "${remaining}" == "0" && "${ok}" == "true" ]]; then exit 0; fi
  if [[ "${updated}" == "0" ]]; then echo '::error::No progress in snapshot reconciliation'; exit 1; fi
  sleep 5
done
echo '::error::Snapshot reconciliation still has pending races'; exit 1
