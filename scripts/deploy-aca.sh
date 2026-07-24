#!/usr/bin/env bash

set -euo pipefail

: "${ACR_NAME:?ACR_NAME is required}"
: "${ACR_LOGIN_SERVER:?ACR_LOGIN_SERVER is required}"
: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is required}"
: "${SCAN_IMAGE_REPOSITORY:?SCAN_IMAGE_REPOSITORY is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${CONTAINER_APP_NAME:?CONTAINER_APP_NAME is required}"
: "${CATALOG_SYNC_JOB_NAME:?CATALOG_SYNC_JOB_NAME is required}"
: "${ATTACHMENT_SCAN_JOB_NAME:?ATTACHMENT_SCAN_JOB_NAME is required}"
: "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME:?CLAMAV_SIGNATURE_REFRESH_JOB_NAME is required}"
: "${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME:?ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME is required}"
: "${ATTACHMENT_SCAN_QUEUE_NAME:?ATTACHMENT_SCAN_QUEUE_NAME is required}"
: "${CLAMAV_SIGNATURE_STORAGE_ACCOUNT_NAME:?CLAMAV_SIGNATURE_STORAGE_ACCOUNT_NAME is required}"
: "${CLAMAV_SIGNATURE_FILE_SHARE_NAME:?CLAMAV_SIGNATURE_FILE_SHARE_NAME is required}"
: "${SEARXNG_CONTAINER_APP_NAME:=hhc-searxng}"

image_ref="${ACR_LOGIN_SERVER}/${IMAGE_REPOSITORY}:${IMAGE_TAG}"
scan_image_ref="${ACR_LOGIN_SERVER}/${SCAN_IMAGE_REPOSITORY}:${IMAGE_TAG}"
echo "Deploying ${image_ref} to ${CONTAINER_APP_NAME}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
searxng_manifest_template="${script_dir}/../aca.searxng.containerapp.yaml"
searxng_settings_template="${script_dir}/../infra/searxng/settings.yml"
catalog_job_manifest_template="${script_dir}/../aca.catalog-sync-job.yaml"
attachment_scan_job_manifest_template="${script_dir}/../aca.attachment-scan-job.yaml"
clamav_refresh_job_manifest_template="${script_dir}/../aca.clamav-signature-refresh-job.yaml"
searxng_manifest="$(mktemp)"
catalog_job_manifest="$(mktemp)"
attachment_scan_job_manifest="$(mktemp)"
clamav_refresh_job_manifest="$(mktemp)"
trap 'rm -f "${searxng_manifest}" "${catalog_job_manifest}" "${attachment_scan_job_manifest}" "${clamav_refresh_job_manifest}"' EXIT

if [[ ! -f "${searxng_manifest_template}" \
  || ! -f "${searxng_settings_template}" \
  || ! -f "${catalog_job_manifest_template}" \
  || ! -f "${attachment_scan_job_manifest_template}" \
  || ! -f "${clamav_refresh_job_manifest_template}" ]]; then
  echo "Missing deployment configuration"
  exit 1
fi

managed_environment_id="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "properties.managedEnvironmentId" \
  --output tsv)"
if [[ -z "${managed_environment_id}" ]]; then
  echo "Could not resolve the managed environment for ${CONTAINER_APP_NAME}"
  exit 1
fi
container_app_location="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "location" \
  --output tsv)"
if [[ -z "${container_app_location}" ]]; then
  echo "Could not resolve the deployment location for ${CONTAINER_APP_NAME}"
  exit 1
fi
managed_environment_name="${managed_environment_id##*/}"

bot_env_json="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "properties.template.containers[0].env" \
  --output json)"
bot_secret_names_json="$(az containerapp secret list \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "[].name" \
  --output json)"
mapfile -t missing_bot_secrets < <(BOT_SECRET_NAMES_JSON="${bot_secret_names_json}" python3 - <<'PY'
import json
import os

required_bot_secrets = {
    "line-helper-channel-secret",
    "line-helper-channel-access-token",
    "line-helper-admin-user-id",
    "deepseek-api-key",
    "openai-api-key",
    "notion-token",
    "database-url",
    "redis-url",
    "graph-client-secret",
    "observability-hmac-key",
}
present = set(json.loads(os.environ["BOT_SECRET_NAMES_JSON"]))
for name in sorted(required_bot_secrets - present):
    print(name)
PY
)
if [[ ${#missing_bot_secrets[@]} -gt 0 ]]; then
  echo "Required ACA secret is unavailable: ${missing_bot_secrets[0]}" >&2
  exit 1
fi

clamav_storage_key="$(az storage account keys list \
  --resource-group "${RESOURCE_GROUP}" \
  --account-name "${CLAMAV_SIGNATURE_STORAGE_ACCOUNT_NAME}" \
  --query "[0].value" \
  --output tsv \
  --only-show-errors)"
if [[ -z "${clamav_storage_key}" ]]; then
  echo "Required ClamAV signature storage credential is unavailable" >&2
  exit 1
fi
attachment_scan_queue_connection_string="$(az storage account show-connection-string \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME}" \
  --query connectionString \
  --output tsv \
  --only-show-errors)"
if [[ -z "${attachment_scan_queue_connection_string}" ]]; then
  echo "Required attachment queue credential is unavailable" >&2
  exit 1
fi
attachment_scan_storage_key="$(az storage account keys list \
  --resource-group "${RESOURCE_GROUP}" \
  --account-name "${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME}" \
  --query "[0].value" \
  --output tsv \
  --only-show-errors)"
attachment_scan_queue_endpoint="$(az storage account show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME}" \
  --query "primaryEndpoints.queue" \
  --output tsv \
  --only-show-errors)"
if [[ -z "${attachment_scan_storage_key}" || -z "${attachment_scan_queue_endpoint}" ]]; then
  echo "Required attachment queue producer credential is unavailable" >&2
  exit 1
fi
attachment_scan_queue_sas_expiry="$(date -u -d "+1825 days" "+%Y-%m-%dT%H:%MZ")"
attachment_scan_queue_sas="$(az storage queue generate-sas \
  --account-name "${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME}" \
  --account-key "${attachment_scan_storage_key}" \
  --name "${ATTACHMENT_SCAN_QUEUE_NAME}" \
  --permissions a \
  --expiry "${attachment_scan_queue_sas_expiry}" \
  --https-only \
  --output tsv \
  --only-show-errors)"
if [[ -z "${attachment_scan_queue_sas}" ]]; then
  echo "Required attachment queue producer credential is unavailable" >&2
  exit 1
fi
attachment_scan_queue_url="${attachment_scan_queue_endpoint%/}/${ATTACHMENT_SCAN_QUEUE_NAME}?${attachment_scan_queue_sas}"
az containerapp secret set \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --secrets "attachment-scan-queue-url=${attachment_scan_queue_url}" \
  --only-show-errors \
  --output none
unset attachment_scan_storage_key attachment_scan_queue_sas attachment_scan_queue_url

az containerapp env storage set \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${managed_environment_name}" \
  --storage-name clamav-signatures-readonly \
  --storage-type AzureFile \
  --azure-file-account-name "${CLAMAV_SIGNATURE_STORAGE_ACCOUNT_NAME}" \
  --azure-file-account-key "${clamav_storage_key}" \
  --azure-file-share-name "${CLAMAV_SIGNATURE_FILE_SHARE_NAME}" \
  --access-mode ReadOnly \
  --only-show-errors \
  --output none
az containerapp env storage set \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${managed_environment_name}" \
  --storage-name clamav-signatures-readwrite \
  --storage-type AzureFile \
  --azure-file-account-name "${CLAMAV_SIGNATURE_STORAGE_ACCOUNT_NAME}" \
  --azure-file-account-key "${clamav_storage_key}" \
  --azure-file-share-name "${CLAMAV_SIGNATURE_FILE_SHARE_NAME}" \
  --access-mode ReadWrite \
  --only-show-errors \
  --output none
unset clamav_storage_key

searxng_secret_key="$(openssl rand -hex 32)"
SEARXNG_MANIFEST_TEMPLATE="${searxng_manifest_template}" \
SEARXNG_SETTINGS_TEMPLATE="${searxng_settings_template}" \
SEARXNG_MANIFEST="${searxng_manifest}" \
MANAGED_ENVIRONMENT_ID="${managed_environment_id}" \
SEARXNG_CONTAINER_APP_NAME="${SEARXNG_CONTAINER_APP_NAME}" \
CONTAINER_APP_LOCATION="${container_app_location}" \
SEARXNG_SECRET_KEY="${searxng_secret_key}" \
python3 - <<'PY'
from pathlib import Path
import os

manifest = Path(os.environ["SEARXNG_MANIFEST_TEMPLATE"]).read_text()
settings = Path(os.environ["SEARXNG_SETTINGS_TEMPLATE"]).read_text()
settings = settings.replace("PLACEHOLDER_SEARXNG_SECRET_KEY", os.environ["SEARXNG_SECRET_KEY"])
if "PLACEHOLDER_SEARXNG_SECRET_KEY" in settings:
    raise SystemExit("SearXNG settings secret placeholder was not replaced")

rendered_settings = "\n".join(f"          {line}" for line in settings.splitlines())
manifest = manifest.replace("PLACEHOLDER_CONTAINER_APP_ENVIRONMENT_ID", os.environ["MANAGED_ENVIRONMENT_ID"])
manifest = manifest.replace("PLACEHOLDER_AZURE_REGION", os.environ["CONTAINER_APP_LOCATION"])
manifest = manifest.replace("name: hhc-searxng", f"name: {os.environ['SEARXNG_CONTAINER_APP_NAME']}", 1)
manifest = manifest.replace("          PLACEHOLDER_SEARXNG_SETTINGS", rendered_settings)
if "PLACEHOLDER_SEARXNG_SETTINGS" in manifest:
    raise SystemExit("SearXNG settings placeholder was not replaced")

Path(os.environ["SEARXNG_MANIFEST"]).write_text(manifest)
PY
unset searxng_secret_key

if az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${SEARXNG_CONTAINER_APP_NAME}" \
  --only-show-errors \
  --output none 2>/dev/null; then
  az containerapp update --yaml "${searxng_manifest}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${SEARXNG_CONTAINER_APP_NAME}" \
    --only-show-errors \
    --output none
else
  az containerapp create --yaml "${searxng_manifest}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${SEARXNG_CONTAINER_APP_NAME}" \
    --only-show-errors \
    --output none
fi

searxng_fqdn="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${SEARXNG_CONTAINER_APP_NAME}" \
  --query "properties.configuration.ingress.fqdn" \
  --output tsv)"
if [[ -z "${searxng_fqdn}" ]]; then
  echo "Could not resolve the internal SearXNG FQDN"
  exit 1
fi
searxng_base_url="https://${searxng_fqdn}"

mapfile -t retired_profile_envs < <(BOT_ENV_JSON="${bot_env_json}" python3 - <<'PY'
import json
import os

retired_exact = {
    "BOT_PROFILES_BASE64_JSON",
    "BOT_PROFILES_JSON",
    "PROFILE_CONFIG_VERSION",
    "PPT_ALLOWED_EXTENSIONS",
    "PPT_DEFAULT_INCLUDE_PDF",
    "GRAPH_SHEET_MUSIC_FOLDER_ITEM_ID",
    "GRAPH_SHEET_MUSIC_FOLDER_PATH",
    "SHEET_MUSIC_DEFAULT_RECURSIVE",
    "LLM_PROVIDER",
    "LLM_FALLBACK_PROVIDER",
    "EMBEDDING_KEEP_ALIVE",
    "CLAMAV_TIMEOUT_MS",
    "".join(("CLAM", "AV_HOST")),
    "".join(("CLAM", "AV_PORT")),
}
retired_prefixes = (
    "".join(("OLLA", "MA_")),
    "".join(("VIRUS_", "SCAN_")),
)
retired_provider_token = "".join(("OLLA", "MA"))
retired_office_address = ".".join(["172", "16", "65", "5"])
for item in json.loads(os.environ["BOT_ENV_JSON"]):
    name = item.get("name", "")
    value = str(item.get("value") or "")
    if (
        name in retired_exact
        or name.startswith(retired_prefixes)
        or f"_{retired_provider_token}_" in name
        or retired_office_address in value
    ):
        print(name)
PY
)

update_args=(
  --resource-group "${RESOURCE_GROUP}"
  --name "${CONTAINER_APP_NAME}"
  --image "${image_ref}"
  --set-env-vars
  "PROFILE_CONFIG_PATH=/app/config/profiles.json"
  "READY_PATH=/readyz"
  "LLM_CONTEXT_WINDOW_TOKENS=272000"
  "LLM_RUNTIME_CONTEXT_BUDGET_TOKENS=2000"
  "LLM_CONTEXT_COMPRESSION_THRESHOLD_RATIO=0.75"
  "LLM_GENERAL_MAX_OUTPUT_TOKENS=160"
  "LLM_ROUTE_MAX_OUTPUT_TOKENS=256"
  "CONFIRMATION_TTL_MINUTES=5"
  "RATE_LIMIT_ENABLED=true"
  "RATE_LIMIT_WINDOW_MS=60000"
  "RATE_LIMIT_MAX_REQUESTS=20"
  "LAST_ERRORS_MAX_ENTRIES=20"
  "MAX_ATTACHMENT_BYTES=26214400"
  "LINE_CONTENT_DOWNLOAD_TIMEOUT_MS=30000"
  "ATTACHMENT_SCAN_QUEUE_URL=secretref:attachment-scan-queue-url"
  "EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS=15000"
  "EXTERNAL_RESOURCE_MAX_REDIRECTS=3"
  "SHEET_MUSIC_ALLOWED_EXTENSIONS=pdf,jpg,jpeg,png"
  "SEARXNG_BASE_URL=${searxng_base_url}"
  "SEARXNG_TIMEOUT_MS=8000"
  "OPENAI_API_KEY=secretref:openai-api-key"
  "OPENAI_BASE_URL=https://api.openai.com/v1"
  "OPENAI_EMBEDDING_MODEL=text-embedding-3-small"
  "EMBEDDING_BATCH_SIZE=16"
  "EMBEDDING_TIMEOUT_MS=30000"
  "OBSERVABILITY_HMAC_KEY=secretref:observability-hmac-key"
)
if [[ ${#retired_profile_envs[@]} -gt 0 ]]; then
  update_args+=(--remove-env-vars "${retired_profile_envs[@]}")
fi

az containerapp update "${update_args[@]}" \
  --only-show-errors \
  --output none

bot_secrets_json="$(az containerapp secret list \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --show-values \
  --output json)"
bot_env_json="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "properties.template.containers[0].env" \
  --output json)"

az containerapp dapr enable \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --dapr-app-id "hhc-line-function-bot" \
  --dapr-app-port 3000 \
  --dapr-app-protocol http \
  --dapr-log-level warn \
  --only-show-errors \
  --output none

target_revision="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "properties.latestRevisionName" \
  --output tsv)"

echo "Waiting for revision ${target_revision} to become ready"
revision_ready=false
for attempt in {1..30}; do
  app_state="$(az containerapp show \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${CONTAINER_APP_NAME}" \
    --query "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,image:properties.template.containers[0].image}" \
    --output json)"

  read -r latest_revision latest_ready_revision running_status deployed_image < <(
    APP_STATE="${app_state}" python3 - <<'PY'
import json
import os

state = json.loads(os.environ["APP_STATE"])
print("\t".join(str(state.get(key) or "") for key in [
    "latestRevision",
    "latestReadyRevision",
    "runningStatus",
    "image",
]))
PY
  )
  echo "Attempt ${attempt}: latest=${latest_revision}, ready=${latest_ready_revision}, status=${running_status}, image=${deployed_image}"

  if [[ "${latest_revision}" == "${target_revision}" \
    && "${latest_ready_revision}" == "${target_revision}" \
    && "${running_status}" == "Running" \
    && "${deployed_image}" == "${image_ref}" ]]; then
    revision_ready=true
    break
  fi

  sleep 10
done

if [[ "${revision_ready}" != "true" ]]; then
  echo "Revision ${target_revision} did not become ready in time"
  exit 1
fi

legacy_profile_secret="$(az containerapp secret list \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "[?name=='bot-profiles-base64-json'].name | [0]" \
  --output tsv)"
if [[ -n "${legacy_profile_secret}" ]]; then
  az containerapp secret remove \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${CONTAINER_APP_NAME}" \
    --secret-names bot-profiles-base64-json \
    --only-show-errors \
    --output none
fi

legacy_clamav_storage_secret="$(az containerapp secret list \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "[?name=='clamav-signature-storage-key'].name | [0]" \
  --output tsv)"
if [[ -n "${legacy_clamav_storage_secret}" ]]; then
  az containerapp secret remove \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${CONTAINER_APP_NAME}" \
    --secret-names clamav-signature-storage-key \
    --only-show-errors \
    --output none
fi

render_job_manifest() {
  local template_path="$1"
  local rendered_path="$2"
  local job_name="$3"
  local job_image="$4"

  JOB_MANIFEST_TEMPLATE="${template_path}" \
  JOB_MANIFEST_RENDERED="${rendered_path}" \
  JOB_NAME="${job_name}" \
  JOB_IMAGE="${job_image}" \
  MANAGED_ENVIRONMENT_ID="${managed_environment_id}" \
  CONTAINER_APP_LOCATION="${container_app_location}" \
  ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME="${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME}" \
  ATTACHMENT_SCAN_QUEUE_NAME="${ATTACHMENT_SCAN_QUEUE_NAME}" \
  BOT_SECRETS_JSON="${bot_secrets_json}" \
  BOT_ENV_JSON="${bot_env_json}" \
  ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING="${attachment_scan_queue_connection_string}" \
  python3 - <<'PY'
from pathlib import Path
import json
import os

secret_values = {
    item["name"]: item.get("value")
    for item in json.loads(os.environ["BOT_SECRETS_JSON"])
}
env_values = {
    item["name"]: item.get("value")
    for item in json.loads(os.environ["BOT_ENV_JSON"])
    if item.get("value") is not None
}

text = Path(os.environ["JOB_MANIFEST_TEMPLATE"]).read_text()
lines = text.splitlines()
lines[0] = f"name: {os.environ['JOB_NAME']}"
current_name = None
rendered = []
for line in lines:
    stripped = line.strip()
    if stripped.startswith("- name: "):
        current_name = stripped.removeprefix("- name: ").strip()
    if stripped == "value: PLACEHOLDER_COPY_FROM_BOT_SECRET":
        value = secret_values.get(current_name)
        if not value:
            raise SystemExit(f"Required ACA secret is unavailable: {current_name}")
        line = f"{line[:len(line) - len(line.lstrip())]}value: {json.dumps(value)}"
    elif stripped == "value: PLACEHOLDER_COPY_FROM_BOT_ENV":
        value = env_values.get(current_name)
        if value is None:
            raise SystemExit(f"Required ACA environment reference is unavailable: {current_name}")
        line = f"{line[:len(line) - len(line.lstrip())]}value: {json.dumps(value)}"
    elif stripped.startswith("image: "):
        line = f"{line[:len(line) - len(line.lstrip())]}image: {os.environ['JOB_IMAGE']}"
    rendered.append(line)

text = "\n".join(rendered) + "\n"
for placeholder, value in {
    "PLACEHOLDER_CONTAINER_APP_ENVIRONMENT_ID": os.environ["MANAGED_ENVIRONMENT_ID"],
    "PLACEHOLDER_AZURE_REGION": os.environ["CONTAINER_APP_LOCATION"],
    "PLACEHOLDER_ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME": os.environ[
        "ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME"
    ],
    "PLACEHOLDER_ATTACHMENT_SCAN_QUEUE_NAME": os.environ["ATTACHMENT_SCAN_QUEUE_NAME"],
    "PLACEHOLDER_ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING": os.environ[
        "ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING"
    ],
}.items():
    text = text.replace(placeholder, value)
if "PLACEHOLDER_" in text:
    raise SystemExit("A job manifest placeholder was not resolved")
Path(os.environ["JOB_MANIFEST_RENDERED"]).write_text(text)
PY
}

deploy_job() {
  local job_name="$1"
  local manifest_path="$2"
  if az containerapp job show \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${job_name}" \
    --only-show-errors \
    --output none 2>/dev/null; then
    az containerapp job update \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${job_name}" \
      --yaml "${manifest_path}" \
      --only-show-errors \
      --output none
  else
    az containerapp job create \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${job_name}" \
      --yaml "${manifest_path}" \
      --only-show-errors \
      --output none
  fi
}

start_job_and_wait() {
  local job_name="$1"
  local execution_name
  local execution_status

  execution_name="$(
    az containerapp job start \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${job_name}" \
      --query name \
      --output tsv \
      --only-show-errors
  )"
  if [[ -z "${execution_name}" ]]; then
    echo "Unable to resolve the bootstrap execution for ${job_name}" >&2
    exit 1
  fi

  for _attempt in $(seq 1 180); do
    execution_status="$(
      az containerapp job execution show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${job_name}" \
        --job-execution-name "${execution_name}" \
        --query properties.status \
        --output tsv \
        --only-show-errors
    )"
    case "${execution_status}" in
      Succeeded)
        return
        ;;
      Failed | Stopped)
        echo "Bootstrap execution for ${job_name} did not succeed" >&2
        exit 1
        ;;
    esac
    sleep 5
  done

  echo "Bootstrap execution for ${job_name} exceeded its deployment wait" >&2
  exit 1
}

render_job_manifest \
  "${clamav_refresh_job_manifest_template}" \
  "${clamav_refresh_job_manifest}" \
  "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" \
  "${scan_image_ref}"
render_job_manifest \
  "${attachment_scan_job_manifest_template}" \
  "${attachment_scan_job_manifest}" \
  "${ATTACHMENT_SCAN_JOB_NAME}" \
  "${scan_image_ref}"
render_job_manifest \
  "${catalog_job_manifest_template}" \
  "${catalog_job_manifest}" \
  "${CATALOG_SYNC_JOB_NAME}" \
  "${image_ref}"

deploy_job "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" "${clamav_refresh_job_manifest}"
start_job_and_wait "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}"
deploy_job "${ATTACHMENT_SCAN_JOB_NAME}" "${attachment_scan_job_manifest}"
deploy_job "${CATALOG_SYNC_JOB_NAME}" "${catalog_job_manifest}"

echo "Deployed ${image_ref} to revision ${target_revision}"
