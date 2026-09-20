#!/usr/bin/env bash
set -Eeuo pipefail

: "${SUPABASE_BROKER_URL:?SUPABASE_BROKER_URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC request URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token is required}"
: "${MODEL_VERSION:?MODEL_VERSION is required}"
: "${MODEL_BUNDLE:?MODEL_BUNDLE is required}"
: "${MODEL_MANIFEST:?MODEL_MANIFEST is required}"

OIDC_AUDIENCE="rein-supabase-model-v1"
OIDC_TOKEN=""
BROKER_RESPONSE=""

refresh_oidc_token() {
  local response
  response="$(curl --fail-with-body --silent --show-error --retry 3 \
    -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}")"
  OIDC_TOKEN="$(jq -er '.value' <<<"${response}")"
}

broker_call() {
  local payload="$1"
  refresh_oidc_token
  BROKER_RESPONSE="$(curl --fail-with-body --silent --show-error --retry 3 \
    -X POST "${SUPABASE_BROKER_URL}" \
    -H "Authorization: Bearer ${OIDC_TOKEN}" \
    -H "Content-Type: application/json" --data "${payload}")"
}

upload() {
  local object_path="$1" file="$2" content_type="$3" signed_url
  broker_call "$(jq -nc --arg path "${object_path}" '{action:"sign-upload",path:$path}')"
  signed_url="$(jq -er '.signed_url' <<<"${BROKER_RESPONSE}")"
  curl --fail-with-body --silent --show-error --retry 3 -X PUT "${signed_url}" \
    -H "Content-Type: ${content_type}" -H "Cache-Control: max-age=31536000, immutable" \
    -H "x-upsert: true" --data-binary "@${file}" >/dev/null
}

broker_call '{"action":"health"}'
jq -e '.ok == true' <<<"${BROKER_RESPONSE}" >/dev/null

base="rein/models/v4/${MODEL_VERSION}"
upload "${base}/bundle.tar.gz" "${MODEL_BUNDLE}" "application/gzip"
upload "${base}/manifest.json" "${MODEL_MANIFEST}" "application/json"

bundle_sha="$(sha256sum "${MODEL_BUNDLE}" | cut -d' ' -f1)"
bundle_size="$(stat -c '%s' "${MODEL_BUNDLE}")"
activate_payload="$(jq -nc \
  --arg version "${MODEL_VERSION}" \
  --arg trained "$(jq -er '.trained_through' "${MODEL_MANIFEST}")" \
  --arg history "$(jq -er '.history_through' "${MODEL_MANIFEST}")" \
  --arg sha "${bundle_sha}" \
  --argjson size "${bundle_size}" \
  --argjson features "$(jq -er '.feature_count' "${MODEL_MANIFEST}")" \
  --argjson metrics "$(jq -c '.comparison // {}' "${MODEL_METRICS:-/dev/null}" 2>/dev/null || echo '{}')" \
  '{action:"activate",version:$version,trained_through:$trained,history_through:$history,feature_count:$features,artifact_sha256:$sha,artifact_size_bytes:$size,metrics:$metrics}')"
broker_call "${activate_payload}"
jq -e '.ok == true' <<<"${BROKER_RESPONSE}" >/dev/null
echo "Activated ${MODEL_VERSION} in Supabase (${bundle_size} bytes, sha256=${bundle_sha})."
