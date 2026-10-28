#!/usr/bin/env bash
# This job cannot deploy or roll back. Failed-job-only retry repeats acceptance only.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-assurance.sh"
source "$script_dir/maintenance-contract.sh"
: "${SEARXNG_CONTAINER_APP_NAME:=hhc-searxng}"
metadata="$(python3 "$script_dir/release-receipt.py" read)"
while IFS='=' read -r key value; do
  case "$key" in
    RELEASE_TARGET_REVISION|RELEASE_TARGET_IMAGE|RELEASE_TARGET_SCAN_IMAGE|RELEASE_TARGET_ATTACHMENT_IMAGE|RELEASE_TARGET_ATTACHMENT_APP_IMAGE|RELEASE_EXPECTED_SEARXNG_IMAGE|RELEASE_ATTACHMENT_BOOTSTRAP_EXECUTION_NAME|RELEASE_STARTED_AT|RELEASE_KNOWN_GOOD_REVISION|RELEASE_KNOWN_GOOD_IMAGE|DEPLOYED_PUBLIC_STATE|RELEASE_RECOVERY_ENV_JSON) export "$key=$value" ;;
    *) echo 'Unknown release receipt field' >&2; exit 1 ;;
  esac
done <<<"$metadata"
mode="$(observed_gateway_mode)"
if [[ "$mode" == on ]]; then
  [[ "$DEPLOYED_PUBLIC_STATE" == pending && "$public_expectation" == maintenance ]] || exit 1
  # Bind pending to the actual same deployed revision, not merely to a maintenance HTTP error.
  release_wait_for_target
  maintenance_request "${PUBLIC_WEB_ORIGIN:-https://www.alive.org.tw}/api/line/webhook/helper"
  echo 'PUBLIC_ACCEPTANCE_PENDING: Gateway maintenance remains on; public signed webhook acceptance has not run.'
  exit 42
fi
require_gateway_mode off
# The public job is a fresh process; resolve the log workspace owner just as deploy does.
managed_environment_id="$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "$CONTAINER_APP_NAME" --query properties.managedEnvironmentId --output tsv --only-show-errors)"
managed_environment_name="${managed_environment_id##*/}"
[[ "$managed_environment_name" =~ ^[a-z0-9-]+$ ]] || { echo 'Managed environment unavailable' >&2; exit 1; }
# The same full gate and signed-empty 200 checks run after controlled reopening.
RELEASE_PUBLIC_EXPECTATION=normal
run_release_gates
write_release_report
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'commit=%s\nimage=%s\n' "$GITHUB_SHA" "$RELEASE_TARGET_IMAGE" >> "$GITHUB_OUTPUT"
fi
