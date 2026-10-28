#!/usr/bin/env bash

set -euo pipefail

[[ "${RELEASE_COMMIT}" == "${GITHUB_SHA}" ]]
[[ "${RELEASE_IMAGE}" == alive.azurecr.io/alive/hhc-line-function-bot@sha256:* ]]

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
published_dir="$(mktemp -d)"
published_spec="${published_dir}/openapi.yaml"
trap 'rm -rf "${published_dir}"' EXIT
bash "${script_dir}/render-published-openapi.sh" docs/openapi.yaml "${published_spec}"

is_canonical_run_id() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
if ! is_canonical_run_id "${GITHUB_RUN_ID}"; then
  echo "Invalid GITHUB_RUN_ID: expected canonical positive decimal" >&2
  exit 1
fi
release_url_prefix="https://github.com/${GITHUB_REPOSITORY}/actions/runs/"
if [[ "${CI_PROVIDER:-github-actions}" == "azure-pipelines" ]]; then
  : "${SYSTEM_COLLECTIONURI:?}" "${SYSTEM_TEAMPROJECT:?}"
  release_url_prefix="${SYSTEM_COLLECTIONURI%/}/${SYSTEM_TEAMPROJECT}/_build/results?buildId="
fi
release_url="${release_url_prefix}${GITHUB_RUN_ID}"

spec_blob="specs/${GITHUB_SHA}/openapi.yaml"
spec_sha256="$(sha256sum "${published_spec}" | cut -d " " -f 1)"
spec_exists="$(az storage blob exists \
  --account-name "${STORAGE_ACCOUNT}" \
  --container-name "${CONTAINER}" \
  --name "${spec_blob}" \
  --auth-mode login \
  --only-show-errors \
  --query exists \
  --output tsv)"
if [[ "${spec_exists}" == "true" ]]; then
  existing_spec="$(mktemp)"
  az storage blob download \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${CONTAINER}" \
    --name "${spec_blob}" \
    --file "${existing_spec}" \
    --auth-mode login \
    --no-progress \
    --only-show-errors \
    --output none
  if [[ "$(sha256sum "${existing_spec}" | cut -d " " -f 1)" != "${spec_sha256}" ]]; then
    echo "Existing OpenAPI spec hash does not match" >&2
    exit 1
  fi
else
  az storage blob upload \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${CONTAINER}" \
    --name "${spec_blob}" \
    --file "${published_spec}" \
    --auth-mode login \
    --overwrite false \
    --only-show-errors \
    --output none
fi

jq -n \
  --arg service hhc-line-function-bot \
  --arg commit "${RELEASE_COMMIT}" \
  --arg image "${RELEASE_IMAGE}" \
  --arg specBlob "${spec_blob}" \
  --arg specSha256 "${spec_sha256}" \
  --arg releaseUrl "${release_url}" \
  --arg publishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion: 1, service: $service, commit: $commit, image: $image, specBlob: $specBlob, specSha256: $specSha256, releaseUrl: $releaseUrl, publishedAt: $publishedAt}' \
  > current.json

if [[ "${FAIL_OPENAPI_BEFORE_POINTER}" == "true" ]]; then
  echo "Requested failure before API docs pointer upload" >&2
  exit 1
fi

pointer_exists="$(az storage blob exists \
  --account-name "${STORAGE_ACCOUNT}" \
  --container-name "${CONTAINER}" \
  --name current.json \
  --auth-mode login \
  --only-show-errors \
  --query exists \
  --output tsv)"
if [[ "${pointer_exists}" == "true" ]]; then
  current_pointer="$(mktemp)"
  az storage blob download \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${CONTAINER}" \
    --name current.json \
    --file "${current_pointer}" \
    --auth-mode login \
    --no-progress \
    --only-show-errors \
    --output none
  current_run_id="$(jq -er --arg release_url_prefix "${release_url_prefix}" '
    .releaseUrl? as $release_url
    | if ($release_url | type) == "string" and ($release_url | startswith($release_url_prefix))
      then ($release_url | ltrimstr($release_url_prefix))
      else empty
      end
  ' "${current_pointer}" 2>/dev/null)" || current_run_id=""
  migrating_provider=false
  if [[ -z "${current_run_id}" && "${CI_PROVIDER:-}" == "azure-pipelines" ]]; then
    old_url="$(jq -er '.releaseUrl | select(type == "string")' "${current_pointer}")"
    old_prefix="https://github.com/${GITHUB_REPOSITORY}/actions/runs/"
    old_id="${old_url#"${old_prefix}"}"
    [[ "${old_url}" != "${old_id}" ]] && is_canonical_run_id "${old_id}" || exit 1
    old_commit="$(jq -er '.commit | select(test("^[a-f0-9]{40}$"))' "${current_pointer}")"
    # Run numbers from different providers are incomparable; preserve Git ancestry instead.
    git merge-base --is-ancestor "${old_commit}" "${GITHUB_SHA}"
    migrating_provider=true
    current_run_id="${old_id}"
  fi
  if ! is_canonical_run_id "${current_run_id}"; then
    echo "Invalid existing API docs pointer: expected canonical GitHub workflow run ID" >&2
    exit 1
  fi
  export LC_ALL=C
  if [[ "${migrating_provider}" != "true" ]] && { [[ ${#current_run_id} -gt ${#GITHUB_RUN_ID} ]] || {
    [[ ${#current_run_id} -eq ${#GITHUB_RUN_ID} ]] &&
      [[ "${current_run_id}" > "${GITHUB_RUN_ID}" || "${current_run_id}" == "${GITHUB_RUN_ID}" ]]
  }; }; then
    echo "API docs pointer already belongs to workflow run ${current_run_id}; skipping stale or rerun publication"
    exit 0
  fi
fi

az storage blob upload \
  --account-name "${STORAGE_ACCOUNT}" \
  --container-name "${CONTAINER}" \
  --name current.json \
  --file current.json \
  --auth-mode login \
  --overwrite true \
  --only-show-errors \
  --output none
