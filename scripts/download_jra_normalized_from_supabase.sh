#!/usr/bin/env bash
set -Eeuo pipefail

: "${SUPABASE_BROKER_URL:?SUPABASE_BROKER_URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC request URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token is required}"

OIDC_AUDIENCE="rein-supabase-archive-v1"
OUT_DIR="${1:-.odds-normalized}"
mkdir -p "${OUT_DIR}/payouts" "${OUT_DIR}/win-place"

token_response="$(curl --fail-with-body --silent --show-error --retry 3   -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"   "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}")"
OIDC_TOKEN="$(jq -er '.value' <<<"${token_response}")"

broker() {
  local action="$1" path="$2"
  curl --fail-with-body --silent --show-error --retry 3     -X POST "${SUPABASE_BROKER_URL}"     -H "Authorization: Bearer ${OIDC_TOKEN}"     -H "Content-Type: application/json"     --data "$(jq -nc --arg action "${action}" --arg path "${path}" '{action:$action,path:$path}')"
}

python - <<'PY' > /tmp/jra-periods.txt
import csv
from datetime import date
from scripts.plan_all_odds_resume import periods
with open("data/indices/jra-race-pages-2019-2026.csv") as f:
    race_dates={date.fromisoformat(r["race_date"]) for r in csv.DictReader(f)}
for p in periods(race_dates):
    print(p["name"])
PY

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
count=0
while read -r period; do
  year="${period:0:4}"
  path="jra/odds/all-bets/v1/${year}/${period}.tar.gz"
  exists="$(broker exists "${path}" | jq -r '.exists')"
  [[ "${exists}" == "true" ]] || continue
  signed="$(broker sign-download "${path}" | jq -er '.signed_url')"
  curl --fail-with-body --silent --show-error --retry 3 "${signed}" -o "${tmp}"

  payout_member="data/raw/jra-all-odds/normalized/payouts.parquet"
  win_member="data/raw/jra-all-odds/normalized/win-place.parquet"
  if tar -tzf "${tmp}" | grep -qx "${payout_member}"; then
    tar -xOzf "${tmp}" "${payout_member}" > "${OUT_DIR}/payouts/${period}.parquet"
  fi
  if tar -tzf "${tmp}" | grep -qx "${win_member}"; then
    tar -xOzf "${tmp}" "${win_member}" > "${OUT_DIR}/win-place/${period}.parquet"
  fi
  count=$((count+1))
  if (( count % 20 == 0 )); then echo "processed ${count} archives"; fi
done < /tmp/jra-periods.txt

echo "Downloaded normalized files from ${count} JRA archives"
