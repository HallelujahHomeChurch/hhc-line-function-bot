#!/usr/bin/env bash
set -Eeuo pipefail
set +x

if [[ "${KERNEL_LOCAL_LIVE_TEST_MODE:-}" == "1" ]]; then
  FAKE_BIN_DIRECTORY="${KERNEL_LOCAL_LIVE_FAKE_BIN_DIRECTORY:?}"
  az() { bash "${FAKE_BIN_DIRECTORY}/az" "$@"; }
  docker() { bash "${FAKE_BIN_DIRECTORY}/docker" "$@"; }
  timeout() { bash "${FAKE_BIN_DIRECTORY}/timeout" "$@"; }
else
  DOCKER_EXECUTABLE="$(command -v docker.exe || command -v docker || true)"
  [[ -n "$DOCKER_EXECUTABLE" ]] || {
    printf '%s\n' "kernel_local_live_prerequisite_missing:docker" >&2
    exit 2
  }
  docker() { "$DOCKER_EXECUTABLE" "$@"; }
fi

ROOT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIRECTORY}/compose.kernel-local-live.yml"
CASE_ID=""
if (($# == 0)); then
  :
elif (($# == 2)) && [[ "$1" == "--case" ]]; then
  CASE_ID="$2"
else
  printf '%s\n' "usage: pnpm eval:kernel:local-live [-- --case CASE_ID]" >&2
  exit 2
fi

case "$CASE_ID" in
  "" | schedule-explicit | schedule-refinement | schedule-ambiguity | capability-switch | knowledge-follow-up | group-requester-isolation | provider-unavailable | write-preview-confirm) ;;
  *)
    printf '%s\n' "kernel_local_live_case_unknown" >&2
    exit 2
    ;;
esac

for command_name in az docker git timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '%s\n' "kernel_local_live_prerequisite_missing:${command_name}" >&2
    exit 2
  }
done
[[ -d /dev/shm ]] || {
  printf '%s\n' "kernel_local_live_memory_storage_missing" >&2
  exit 2
}

TEMP_DIRECTORY=""
COMPOSE_STARTED=false
CLEANUP_RAN=false
CLEANUP_FAILED=false
deepseek_secret=""
azure_embedding_secret=""

cleanup() {
  if [[ "$CLEANUP_RAN" == "true" ]]; then return 0; fi
  CLEANUP_RAN=true
  if [[ "$COMPOSE_STARTED" == "true" ]]; then
    if ! docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1; then
      CLEANUP_FAILED=true
    fi
  fi
  if [[ -n "$TEMP_DIRECTORY" ]]; then
    rm -rf -- "$TEMP_DIRECTORY"
    [[ ! -e "$TEMP_DIRECTORY" ]] || CLEANUP_FAILED=true
  fi
}
on_signal() {
  cleanup
  exit 2
}
trap cleanup EXIT
trap on_signal INT TERM

cd "$ROOT_DIRECTORY"
COMMIT="$(git rev-parse HEAD)"
IMAGE="kernel-local-live:${COMMIT:0:12}"
RUN_ID="run-$(date -u +%Y%m%d%H%M%S)-$$"
if [[ "${KERNEL_LOCAL_LIVE_TEST_MODE:-}" == "1" ]]; then
  ARTIFACT_ROOT="${KERNEL_LOCAL_LIVE_ARTIFACT_ROOT:?}"
else
  [[ -z "${KERNEL_LOCAL_LIVE_ARTIFACT_ROOT:-}" ]] || {
    printf '%s\n' "kernel_local_live_environment_rejected" >&2
    exit 2
  }
  ARTIFACT_ROOT="$ROOT_DIRECTORY"
fi
ARTIFACT_DIRECTORY="${ARTIFACT_ROOT}/artifacts/kernel-v1"
mkdir -p "$ARTIFACT_DIRECTORY"

docker build --target kernel-local-live -t "$IMAGE" . || exit 2
if [[ -n "$CASE_ID" ]]; then
  docker run --rm "$IMAGE" node dist/tools/eval-kernel-local-live.js --validate-case "$CASE_ID" ||
    exit 2
else
  docker run --rm "$IMAGE" node dist/tools/eval-kernel-local-live.js --validate-case || exit 2
fi
az account show --output none >/dev/null || exit 2

TEMP_DIRECTORY="$(mktemp -d /dev/shm/kernel-local-live.XXXXXXXX)"
chmod 0700 "$TEMP_DIRECTORY"
DEEPSEEK_FILE="${TEMP_DIRECTORY}/deepseek-api-key"
AZURE_EMBEDDING_FILE="${TEMP_DIRECTORY}/azure-openai-embedding-key"

deepseek_secret="$(
  az containerapp secret list \
    --resource-group alive \
    --name hhc-line-function-bot \
    --query "[?name=='deepseek-api-key'].value | [0]" \
    --output tsv
)" || exit 2
azure_embedding_secret="$(
  az containerapp secret list \
    --resource-group alive \
    --name hhc-line-function-bot \
    --query "[?name=='azure-openai-embedding-key'].value | [0]" \
    --output tsv
)" || exit 2
[[ -n "$deepseek_secret" && -n "$azure_embedding_secret" ]] || exit 2
printf '%s' "$deepseek_secret" >"$DEEPSEEK_FILE"
printf '%s' "$azure_embedding_secret" >"$AZURE_EMBEDDING_FILE"
chmod 0600 "$DEEPSEEK_FILE" "$AZURE_EMBEDDING_FILE"

export COMPOSE_PROJECT_NAME="kernel-local-live-${RUN_ID}"
export KERNEL_LOCAL_LIVE_IMAGE="$IMAGE"
export KERNEL_LOCAL_LIVE_RUN_ID="$RUN_ID"
export KERNEL_LOCAL_LIVE_COMMIT="$COMMIT"
export KERNEL_LOCAL_LIVE_CASE_ID="$CASE_ID"
export KERNEL_LOCAL_LIVE_ARTIFACT_DIRECTORY="$ARTIFACT_DIRECTORY"
export KERNEL_DEEPSEEK_SECRET_FILE="$DEEPSEEK_FILE"
export KERNEL_AZURE_EMBEDDING_SECRET_FILE="$AZURE_EMBEDDING_FILE"
if [[ "${DOCKER_EXECUTABLE:-}" == *.exe ]]; then
  export WSLENV="${WSLENV:+${WSLENV}:}COMPOSE_PROJECT_NAME:KERNEL_LOCAL_LIVE_IMAGE:KERNEL_LOCAL_LIVE_RUN_ID:KERNEL_LOCAL_LIVE_COMMIT:KERNEL_LOCAL_LIVE_CASE_ID:KERNEL_LOCAL_LIVE_ARTIFACT_DIRECTORY/p:KERNEL_DEEPSEEK_SECRET_FILE/p:KERNEL_AZURE_EMBEDDING_SECRET_FILE/p"
fi

COMPOSE_CONFIG_FILE="${TEMP_DIRECTORY}/compose-config.txt"
CONSOLE_FILE="${TEMP_DIRECTORY}/console.txt"
docker compose -f "$COMPOSE_FILE" config >"$COMPOSE_CONFIG_FILE"
COMPOSE_STARTED=true
set +e
timeout --signal=TERM --kill-after=15s 10m \
  docker compose -f "$COMPOSE_FILE" up --abort-on-container-exit --exit-code-from acceptance-driver \
  >"$CONSOLE_FILE" 2>&1
DRIVER_STATUS=$?
set -e

compose_config_contents="$(<"$COMPOSE_CONFIG_FILE")"
console_contents="$(<"$CONSOLE_FILE")"
cleanup
if [[ "$CLEANUP_FAILED" == "true" ]]; then
  exit 2
fi

export KERNEL_LOCAL_LIVE_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export KERNEL_LOCAL_LIVE_COMPOSE_CLEAN=true
export KERNEL_LOCAL_LIVE_SECRET_FILES_CLEAN=true
if ((DRIVER_STATUS == 0)); then
  docker run --rm \
    -e KERNEL_LOCAL_LIVE_ARTIFACT_ROOT=/app \
    -e KERNEL_LOCAL_LIVE_COMPOSE_CLEAN=true \
    -e KERNEL_LOCAL_LIVE_SECRET_FILES_CLEAN=true \
    -v "${ARTIFACT_DIRECTORY}:/app/artifacts/kernel-v1" \
    "$IMAGE" node dist/tools/eval-kernel-local-live.js --finalize-cleanup
else
  ((DRIVER_STATUS == 1)) && exit 1
  exit 2
fi

[[ "$compose_config_contents" != *"$deepseek_secret"* ]] || exit 2
[[ "$compose_config_contents" != *"$azure_embedding_secret"* ]] || exit 2
[[ "$console_contents" != *"$deepseek_secret"* ]] || exit 2
[[ "$console_contents" != *"$azure_embedding_secret"* ]] || exit 2
for scan_file in \
  "$ARTIFACT_DIRECTORY/local-live-suite-result.json" \
  "$ARTIFACT_DIRECTORY/local-live-report.json" \
  "$ARTIFACT_DIRECTORY/local-live-report.md"; do
  [[ -f "$scan_file" ]] || exit 2
  scan_contents="$(<"$scan_file")"
  [[ "$scan_contents" != *"$deepseek_secret"* ]] || exit 2
  [[ "$scan_contents" != *"$azure_embedding_secret"* ]] || exit 2
done
git_contents="$(git diff -- . ':(exclude)artifacts')"
[[ "$git_contents" != *"$deepseek_secret"* ]] || exit 2
[[ "$git_contents" != *"$azure_embedding_secret"* ]] || exit 2
unset compose_config_contents console_contents scan_contents git_contents
unset deepseek_secret azure_embedding_secret

printf '%s\n' "Kernel v1 local live cleanup: PASS"
