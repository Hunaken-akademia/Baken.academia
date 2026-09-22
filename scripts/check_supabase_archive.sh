#!/usr/bin/env bash
set -Eeuo pipefail

: "${ARCHIVE_OBJECT_PATH:?ARCHIVE_OBJECT_PATH is required}"
: "${SUPABASE_BROKER_URL:?SUPABASE_BROKER_URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC request URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

OIDC_AUDIENCE="rein-supabase-archive-v1"
manifest_path="${ARCHIVE_OBJECT_PATH%.tar.gz}.manifest.json"

token_response="$(curl --fail-with-body --silent --show-error --retry 3   -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"   "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}")"
oidc_token="$(jq -er '.value' <<<"${token_response}")"

exists_path() {
  local path="$1"
  curl --fail-with-body --silent --show-error --retry 3     -X POST "${SUPABASE_BROKER_URL}"     -H "Authorization: Bearer ${oidc_token}"     -H "Content-Type: application/json"     --data "$(jq -nc --arg path "${path}" '{action:"exists",path:$path}')"     | jq -r '.exists'
}

archive_exists="$(exists_path "${ARCHIVE_OBJECT_PATH}")"
manifest_exists="$(exists_path "${manifest_path}")"

if [[ "${archive_exists}" == "true" && "${manifest_exists}" == "true" ]]; then
  echo "exists=true" >> "${GITHUB_OUTPUT}"
  echo "Supabase archive already complete: ${ARCHIVE_OBJECT_PATH}"
else
  echo "exists=false" >> "${GITHUB_OUTPUT}"
  echo "Supabase archive missing or incomplete: ${ARCHIVE_OBJECT_PATH}"
fi
