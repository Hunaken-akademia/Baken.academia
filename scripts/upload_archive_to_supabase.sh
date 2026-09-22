#!/usr/bin/env bash
set -Eeuo pipefail

: "${ARCHIVE_FILE:?ARCHIVE_FILE is required}"
: "${ARCHIVE_OBJECT_PATH:?ARCHIVE_OBJECT_PATH is required}"
: "${ARCHIVE_DATASET:?ARCHIVE_DATASET is required}"
: "${SUPABASE_BROKER_URL:?SUPABASE_BROKER_URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC request URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token is required}"

OIDC_AUDIENCE="rein-supabase-archive-v1"
OIDC_TOKEN=""
OIDC_REFRESHED_AT=0
BROKER_RESPONSE=""

refresh_oidc_token() {
  local now token_response
  now="$(date +%s)"
  if [[ -n "${OIDC_TOKEN}" ]] && (( now - OIDC_REFRESHED_AT < 240 )); then
    return
  fi

  token_response="$(curl --fail-with-body --silent --show-error --retry 3     -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"     "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}")"
  OIDC_TOKEN="$(jq -er '.value' <<<"${token_response}")"
  OIDC_REFRESHED_AT="${now}"
}

broker_call() {
  local action="$1"
  local path="${2:-}"
  local payload

  refresh_oidc_token
  if [[ -n "${path}" ]]; then
    payload="$(jq -nc --arg action "${action}" --arg path "${path}"       '{action: $action, path: $path}')"
  else
    payload="$(jq -nc --arg action "${action}" '{action: $action}')"
  fi

  BROKER_RESPONSE="$(curl --fail-with-body --silent --show-error --retry 3     -X POST "${SUPABASE_BROKER_URL}"     -H "Authorization: Bearer ${OIDC_TOKEN}"     -H "Content-Type: application/json"     --data "${payload}")"
}

upload_signed() {
  local path="$1"
  local file="$2"
  local content_type="$3"
  local signed_url

  broker_call "sign-upload" "${path}"
  signed_url="$(jq -er '.signed_url' <<<"${BROKER_RESPONSE}")"
  curl --fail-with-body --silent --show-error --retry 3     -X PUT "${signed_url}"     -H "Content-Type: ${content_type}"     -H "Cache-Control: max-age=31536000"     -H "x-upsert: true"     --data-binary "@${file}" >/dev/null
}

download_signed() {
  local path="$1"
  local output="$2"
  local signed_url

  broker_call "sign-download" "${path}"
  signed_url="$(jq -er '.signed_url' <<<"${BROKER_RESPONSE}")"
  curl --fail-with-body --silent --show-error --retry 3     "${signed_url}" --output "${output}"
}

test -s "${ARCHIVE_FILE}"

broker_call "health"
jq -e '.ok == true' <<<"${BROKER_RESPONSE}" >/dev/null

sha256="$(sha256sum "${ARCHIVE_FILE}" | cut -d' ' -f1)"
size_bytes="$(stat -c '%s' "${ARCHIVE_FILE}")"
manifest_path="${ARCHIVE_OBJECT_PATH%.tar.gz}.manifest.json"

broker_call "exists" "${ARCHIVE_OBJECT_PATH}"
archive_exists="$(jq -r '.exists' <<<"${BROKER_RESPONSE}")"

verify_file="$(mktemp)"
manifest_file="$(mktemp)"
trap 'rm -f "${verify_file}" "${manifest_file}"' EXIT

if [[ "${archive_exists}" == "true" ]]; then
  download_signed "${ARCHIVE_OBJECT_PATH}" "${verify_file}"
  verified_sha256="$(sha256sum "${verify_file}" | cut -d' ' -f1)"
  if [[ "${verified_sha256}" != "${sha256}" ]]; then
    echo "Existing archive differs; replacing: ${ARCHIVE_OBJECT_PATH}"
    upload_signed "${ARCHIVE_OBJECT_PATH}" "${ARCHIVE_FILE}" "application/gzip"
    download_signed "${ARCHIVE_OBJECT_PATH}" "${verify_file}"
    verified_sha256="$(sha256sum "${verify_file}" | cut -d' ' -f1)"
  else
    echo "Existing Supabase archive checksum matches: ${ARCHIVE_OBJECT_PATH}"
  fi
else
  upload_signed "${ARCHIVE_OBJECT_PATH}" "${ARCHIVE_FILE}" "application/gzip"
  download_signed "${ARCHIVE_OBJECT_PATH}" "${verify_file}"
  verified_sha256="$(sha256sum "${verify_file}" | cut -d' ' -f1)"
fi

if [[ "${verified_sha256}" != "${sha256}" ]]; then
  echo "::error::Checksum mismatch after Supabase upload: ${ARCHIVE_OBJECT_PATH}"
  exit 1
fi

python - "${manifest_file}" "${ARCHIVE_OBJECT_PATH}" "${sha256}" "${size_bytes}" "${ARCHIVE_DATASET}" "${GITHUB_RUN_ID:-0}" "${GITHUB_JOB:-unknown}" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, object_path, sha256, size_bytes, dataset, run_id, job = sys.argv[1:]
payload = {
    "schema_version": 1,
    "dataset": dataset,
    "object_path": object_path,
    "sha256": sha256,
    "size_bytes": int(size_bytes),
    "verified": True,
    "source_repository": "Hunaken-akademia/Baken.academia",
    "source_workflow_run_id": int(run_id),
    "source_job": job,
    "archived_at": datetime.now(timezone.utc).isoformat(),
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

upload_signed "${manifest_path}" "${manifest_file}" "application/json"
echo "Supabase archive verified: ${ARCHIVE_OBJECT_PATH} (${size_bytes} bytes, sha256=${sha256})"
