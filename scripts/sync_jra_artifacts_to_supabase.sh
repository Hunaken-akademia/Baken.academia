#!/usr/bin/env bash
set -Eeuo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${SUPABASE_BROKER_URL:?SUPABASE_BROKER_URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC request URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token is required}"

BUCKET="${SUPABASE_BUCKET:-baken-archive}"
WORKFLOW_FILE="${SOURCE_WORKFLOW_FILE:-jra-all-odds-backfill.yml}"
RUN_ID="${SOURCE_RUN_ID:-}"
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

  token_response="$(curl --fail-with-body --silent --show-error --retry 3 \
    -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}")"
  OIDC_TOKEN="$(jq -er '.value' <<<"${token_response}")"
  OIDC_REFRESHED_AT="${now}"
}

broker_call() {
  local action="$1"
  local path="${2:-}"
  local payload

  refresh_oidc_token
  if [[ -n "${path}" ]]; then
    payload="$(jq -nc --arg action "${action}" --arg path "${path}" \
      '{action: $action, path: $path}')"
  else
    payload="$(jq -nc --arg action "${action}" '{action: $action}')"
  fi

  BROKER_RESPONSE="$(curl --fail-with-body --silent --show-error --retry 3 \
    -X POST "${SUPABASE_BROKER_URL}" \
    -H "Authorization: Bearer ${OIDC_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${payload}")"
}

broker_call "health"
jq -e '.ok == true' <<<"${BROKER_RESPONSE}" >/dev/null
echo "Supabase archive broker authentication succeeded."

if [[ -z "${RUN_ID}" ]]; then
  RUN_ID="$(gh run list --repo "${GITHUB_REPOSITORY}" --workflow "${WORKFLOW_FILE}" --limit 1 --json databaseId --jq '.[0].databaseId')"
fi
if [[ -z "${RUN_ID}" || "${RUN_ID}" == "null" ]]; then
  echo "No source workflow run was found."
  exit 1
fi

echo "Syncing completed artifacts from workflow run ${RUN_ID}"
tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

artifacts_tsv="${tmp_root}/artifacts.tsv"
gh api --paginate \
  "repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.expired == false and (.name | startswith("jra-all-odds-"))) | [.id, .name] | @tsv' \
  > "${artifacts_tsv}"

if [[ ! -s "${artifacts_tsv}" ]]; then
  echo "No completed JRA odds artifacts are available yet."
  exit 0
fi

synced=0
skipped=0
failed=0

upload_signed() {
  local path="$1"
  local file="$2"
  local content_type="$3"
  local signed_url

  broker_call "sign-upload" "${path}"
  signed_url="$(jq -er '.signed_url' <<<"${BROKER_RESPONSE}")"
  curl --fail-with-body --silent --show-error --retry 3 \
    -X PUT "${signed_url}" \
    -H "Content-Type: ${content_type}" \
    -H "Cache-Control: max-age=31536000" \
    -H "x-upsert: false" \
    --data-binary "@${file}" >/dev/null
}

download_signed() {
  local path="$1"
  local output="$2"
  local signed_url

  broker_call "sign-download" "${path}"
  signed_url="$(jq -er '.signed_url' <<<"${BROKER_RESPONSE}")"
  curl --fail-with-body --silent --show-error --retry 3 \
    "${signed_url}" --output "${output}"
}

while IFS=$'\t' read -r artifact_id artifact_name; do
  period="${artifact_name#jra-all-odds-}"
  year="${period:0:4}"
  object_path="jra/odds/all-bets/v1/${year}/${period}.tar.gz"
  manifest_path="jra/odds/all-bets/v1/${year}/${period}.manifest.json"

  broker_call "exists" "${object_path}"
  if [[ "$(jq -r '.exists' <<<"${BROKER_RESPONSE}")" == "true" ]]; then
    echo "Already archived: ${object_path}"
    skipped=$((skipped + 1))
    continue
  fi

  artifact_dir="${tmp_root}/${artifact_name}"
  mkdir -p "${artifact_dir}"
  if ! gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip" > "${artifact_dir}/artifact.zip"; then
    echo "::error::Failed to download artifact ${artifact_name}"
    failed=$((failed + 1))
    continue
  fi
  unzip -q "${artifact_dir}/artifact.zip" -d "${artifact_dir}/contents"
  archive_file="$(find "${artifact_dir}/contents" -type f -name '*.tar.gz' -print -quit)"
  if [[ -z "${archive_file}" ]]; then
    echo "::error::No tar.gz file found in artifact ${artifact_name}"
    failed=$((failed + 1))
    continue
  fi

  sha256="$(sha256sum "${archive_file}" | cut -d' ' -f1)"
  size_bytes="$(stat -c '%s' "${archive_file}")"

  if ! upload_signed "${object_path}" "${archive_file}" "application/gzip"; then
    echo "::error::Failed to upload ${object_path}"
    failed=$((failed + 1))
    continue
  fi

  verify_file="${artifact_dir}/verified.tar.gz"
  if ! download_signed "${object_path}" "${verify_file}"; then
    echo "::error::Failed to download uploaded object ${object_path}"
    failed=$((failed + 1))
    continue
  fi
  verified_sha256="$(sha256sum "${verify_file}" | cut -d' ' -f1)"
  if [[ "${verified_sha256}" != "${sha256}" ]]; then
    echo "::error::Checksum mismatch after upload: ${object_path}"
    failed=$((failed + 1))
    continue
  fi

  manifest_file="${artifact_dir}/manifest.json"
  python - "${manifest_file}" "${RUN_ID}" "${artifact_id}" "${artifact_name}" "${object_path}" "${sha256}" "${size_bytes}" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, run_id, artifact_id, artifact_name, object_path, sha256, size_bytes = sys.argv[1:]
payload = {
    "schema_version": 1,
    "dataset": "jra-all-bet-types-odds",
    "source_workflow_run_id": int(run_id),
    "source_artifact_id": int(artifact_id),
    "source_artifact_name": artifact_name,
    "object_path": object_path,
    "sha256": sha256,
    "size_bytes": int(size_bytes),
    "verified": True,
    "archived_at": datetime.now(timezone.utc).isoformat(),
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

  if ! upload_signed "${manifest_path}" "${manifest_file}" "application/json"; then
    echo "::error::Archive uploaded but manifest failed: ${manifest_path}"
    failed=$((failed + 1))
    continue
  fi

  echo "Archived and verified: ${object_path} (${size_bytes} bytes, sha256=${sha256})"
  synced=$((synced + 1))
  rm -rf "${artifact_dir}"
done < "${artifacts_tsv}"

{
  echo "### Supabase JRA archive sync"
  echo "- Source workflow run: ${RUN_ID}"
  echo "- Uploaded and verified: ${synced}"
  echo "- Already archived: ${skipped}"
  echo "- Failed: ${failed}"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

if (( failed > 0 )); then
  exit 1
fi
