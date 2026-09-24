#!/usr/bin/env bash
set -Eeuo pipefail

: "${ARCHIVE_OBJECT_PATH:?ARCHIVE_OBJECT_PATH is required}"
: "${ARCHIVE_OUTPUT:?ARCHIVE_OUTPUT is required}"
: "${SUPABASE_BROKER_URL:?SUPABASE_BROKER_URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC request URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token is required}"

OIDC_AUDIENCE="rein-supabase-archive-v1"

token_response="$(curl --fail-with-body --silent --show-error --retry 3   -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"   "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}")"
oidc_token="$(jq -er '.value' <<<"${token_response}")"

broker_response="$(curl --fail-with-body --silent --show-error --retry 3   -X POST "${SUPABASE_BROKER_URL}"   -H "Authorization: Bearer ${oidc_token}"   -H "Content-Type: application/json"   --data "$(jq -nc --arg path "${ARCHIVE_OBJECT_PATH}" '{action:"sign-download",path:$path}')")"

signed_url="$(jq -er '.signed_url' <<<"${broker_response}")"
curl --fail-with-body --silent --show-error --retry 3 "${signed_url}" --output "${ARCHIVE_OUTPUT}"
test -s "${ARCHIVE_OUTPUT}"
echo "Downloaded ${ARCHIVE_OBJECT_PATH} -> ${ARCHIVE_OUTPUT}"
