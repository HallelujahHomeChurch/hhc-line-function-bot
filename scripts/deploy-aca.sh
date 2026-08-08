#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/release-assurance.sh"
trap 'release_assurance_on_exit "$?"' EXIT

required_release_environment=(
  ACR_NAME
  ACR_LOGIN_SERVER
  IMAGE_REPOSITORY
  SCAN_IMAGE_REPOSITORY
  IMAGE_TAG
  RESOURCE_GROUP
  CONTAINER_APP_NAME
  CATALOG_SYNC_JOB_NAME
  ATTACHMENT_SCAN_JOB_NAME
  CLAMAV_SIGNATURE_REFRESH_JOB_NAME
  RELEASE_PROBE_JOB_NAME
  PERIODIC_ASSURANCE_JOB_NAME
  ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME
  ATTACHMENT_SCAN_QUEUE_NAME
  ASSET_API_AUDIENCE
  CLAMAV_SIGNATURE_STORAGE_ACCOUNT_NAME
  CLAMAV_SIGNATURE_FILE_SHARE_NAME
)
for required_name in "${required_release_environment[@]}"; do
  if [[ -z "${!required_name-}" ]]; then
    set_release_failure preflight_failed
    echo "Required release environment is unavailable: ${required_name}" >&2
    exit 1
  fi
done

: "${SEARXNG_CONTAINER_APP_NAME:=hhc-searxng}"
: "${PUBLIC_WEB_ORIGIN:=https://www.alive.org.tw}"
: "${CONTAINER_APP_JOB_IDENTITY_NAME:=hhc-line-bot-jobs}"
: "${ATTACHMENT_JOB_IDENTITY_NAME:=hhc-line-bot-attachment}"
: "${ASSET_API_CONTAINER_APP_NAME:=asset-api}"
: "${AZURE_OPENAI_EMBEDDING_RESOURCE_NAME:=bible-text-embedding-resource}"
: "${AZURE_OPENAI_EMBEDDING_DEPLOYMENT:=text-embedding-3-small}"
: "${AZURE_OPENAI_EMBEDDING_API_VERSION:=2024-10-21}"

if ! image_ref="$(
  resolve_release_image "${ACR_LOGIN_SERVER}/${IMAGE_REPOSITORY}:${IMAGE_TAG}"
)" || ! scan_image_ref="$(
  resolve_release_image "${ACR_LOGIN_SERVER}/${SCAN_IMAGE_REPOSITORY}:${IMAGE_TAG}"
)"; then
  set_release_failure preflight_failed
  echo "Could not resolve immutable release image digests" >&2
  exit 1
fi
echo "Deploying ${image_ref} to ${CONTAINER_APP_NAME}"

bot_manifest_template="${script_dir}/../aca.containerapp.yaml"
searxng_manifest_template="${script_dir}/../aca.searxng.containerapp.yaml"
searxng_settings_template="${script_dir}/../infra/searxng/settings.yml"
catalog_job_manifest_template="${script_dir}/../aca.catalog-sync-job.yaml"
attachment_scan_job_manifest_template="${script_dir}/../aca.attachment-scan-job.yaml"
clamav_refresh_job_manifest_template="${script_dir}/../aca.clamav-signature-refresh-job.yaml"
release_probe_job_manifest_template="${script_dir}/../aca.release-probe-job.yaml"
periodic_assurance_job_manifest_template="${script_dir}/../aca.periodic-assurance-job.yaml"
bot_manifest="$(mktemp)"
searxng_manifest="$(mktemp)"
catalog_job_manifest="$(mktemp)"
attachment_scan_job_manifest="$(mktemp)"
clamav_refresh_job_manifest="$(mktemp)"
release_probe_job_manifest="$(mktemp)"
periodic_assurance_job_manifest="$(mktemp)"
RELEASE_CLEANUP_FILES=(
  "${bot_manifest}"
  "${searxng_manifest}"
  "${catalog_job_manifest}"
  "${attachment_scan_job_manifest}"
  "${clamav_refresh_job_manifest}"
  "${release_probe_job_manifest}"
  "${periodic_assurance_job_manifest}"
)

if [[ ! -f "${bot_manifest_template}" \
  || ! -f "${searxng_manifest_template}" \
  || ! -f "${searxng_settings_template}" \
  || ! -f "${catalog_job_manifest_template}" \
  || ! -f "${attachment_scan_job_manifest_template}" \
  || ! -f "${clamav_refresh_job_manifest_template}" \
  || ! -f "${release_probe_job_manifest_template}" \
  || ! -f "${periodic_assurance_job_manifest_template}" ]]; then
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
container_app_job_identity_id="$(az identity show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_JOB_IDENTITY_NAME}" \
  --query id \
  --output tsv \
  --only-show-errors)"
if [[ -z "${container_app_job_identity_id}" ]]; then
  echo "Could not resolve the Container Apps Job identity ${CONTAINER_APP_JOB_IDENTITY_NAME}"
  exit 1
fi
attachment_job_identity_json="$(az identity show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ATTACHMENT_JOB_IDENTITY_NAME}" \
  --query '{id:id,clientId:clientId,principalId:principalId}' \
  --output json \
  --only-show-errors)"
read -r attachment_job_identity_id attachment_job_client_id attachment_job_principal_id < <(
  ATTACHMENT_JOB_IDENTITY_JSON="${attachment_job_identity_json}" python3 - <<'PY'
import json
import os

identity = json.loads(os.environ["ATTACHMENT_JOB_IDENTITY_JSON"] or "null") or {}
print(f"{identity.get('id') or ''}\t{identity.get('clientId') or ''}\t{identity.get('principalId') or ''}")
PY
)
if [[ -z "${attachment_job_identity_id}" \
  || -z "${attachment_job_client_id}" \
  || -z "${attachment_job_principal_id}" ]]; then
  echo "Could not resolve the attachment Job identity ${ATTACHMENT_JOB_IDENTITY_NAME}" >&2
  exit 1
fi

asset_api_fqdn="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ASSET_API_CONTAINER_APP_NAME}" \
  --query properties.configuration.ingress.fqdn \
  --output tsv \
  --only-show-errors)"
if [[ -z "${asset_api_fqdn}" ]]; then
  echo "Could not resolve internal ingress for ${ASSET_API_CONTAINER_APP_NAME}" >&2
  exit 1
fi
asset_api_url="https://${asset_api_fqdn}"

attachment_storage_id="$(az storage account show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME}" \
  --query id \
  --output tsv \
  --only-show-errors)"
attachment_queue_scope="${attachment_storage_id}/queueServices/default/queues/${ATTACHMENT_SCAN_QUEUE_NAME}"
acr_id="$(az acr show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ACR_NAME}" \
  --query id \
  --output tsv \
  --only-show-errors)"
if [[ "$(az role assignment list \
  --scope "${attachment_queue_scope}" \
  --assignee-object-id "${attachment_job_principal_id}" \
  --query "[?roleDefinitionName=='Storage Queue Data Message Processor'] | length(@)" \
  --output tsv \
  --only-show-errors)" != "1" \
  || "$(az role assignment list \
    --scope "${attachment_queue_scope}" \
    --assignee-object-id "${attachment_job_principal_id}" \
    --query "[?roleDefinitionName=='Storage Queue Data Reader'] | length(@)" \
    --output tsv \
    --only-show-errors)" != "1" \
  || "$(az role assignment list \
    --scope "${acr_id}" \
    --assignee-object-id "${attachment_job_principal_id}" \
    --query "[?roleDefinitionName=='AcrPull'] | length(@)" \
    --output tsv \
    --only-show-errors)" != "1" ]]; then
  echo "Attachment Job identity is missing its queue processor, queue reader, or ACR pull role" >&2
  exit 1
fi
if ! verify_asset_access_contract \
  "${RESOURCE_GROUP}" \
  "${ASSET_API_CONTAINER_APP_NAME}" \
  "${ASSET_API_AUDIENCE}" \
  "${attachment_job_client_id}" \
  "${attachment_job_principal_id}"; then
  echo "Asset API workload access contract is unavailable" >&2
  exit 1
fi

azure_openai_embedding_endpoint="$(az cognitiveservices account show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${AZURE_OPENAI_EMBEDDING_RESOURCE_NAME}" \
  --query "properties.endpoint" \
  --output tsv \
  --only-show-errors)"
azure_openai_embedding_deployment_json="$(az cognitiveservices account deployment list \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${AZURE_OPENAI_EMBEDDING_RESOURCE_NAME}" \
  --query "[?name=='${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}'] | [0]" \
  --output json \
  --only-show-errors)"
read -r azure_openai_embedding_model azure_openai_embedding_state < <(
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT_JSON="${azure_openai_embedding_deployment_json}" python3 - <<'PY'
import json
import os

deployment = json.loads(os.environ["AZURE_OPENAI_EMBEDDING_DEPLOYMENT_JSON"] or "null") or {}
properties = deployment.get("properties") or {}
model = properties.get("model") or {}
print(f"{model.get('name') or ''}\t{properties.get('provisioningState') or ''}")
PY
)
if [[ -z "${azure_openai_embedding_endpoint}" \
  || "${azure_openai_embedding_model}" != "text-embedding-3-small" \
  || "${azure_openai_embedding_state}" != "Succeeded" ]]; then
  echo "Required Azure embedding deployment is unavailable" >&2
  exit 1
fi

# Capture every traffic-serving and finite-workload identity before the first
# production write. Compatible secret/storage reconciliation is inside the
# same failure boundary even though rollback ownership is workload-scoped.
capture_known_good_state
mark_release_mutated

azure_openai_embedding_key="$(az cognitiveservices account keys list \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${AZURE_OPENAI_EMBEDDING_RESOURCE_NAME}" \
  --query key1 \
  --output tsv \
  --only-show-errors)"
if [[ -z "${azure_openai_embedding_key}" ]]; then
  echo "Required Azure embedding credential is unavailable" >&2
  exit 1
fi
az containerapp secret set \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --secrets "azure-openai-embedding-key=${azure_openai_embedding_key}" \
  --only-show-errors \
  --output none
unset azure_openai_embedding_key

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
    "line-main-channel-secret",
    "line-main-channel-access-token",
    "deepseek-api-key",
    "azure-openai-embedding-key",
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
RELEASE_EXPECTED_SEARXNG_IMAGE="$(
  awk '$1 == "image:" {print $2; exit}' "${searxng_manifest}"
)"
if [[ -z "${RELEASE_EXPECTED_SEARXNG_IMAGE}" ]]; then
  set_release_failure preflight_failed
  echo "Could not resolve the expected SearXNG image from its rendered manifest" >&2
  exit 1
fi

if az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${SEARXNG_CONTAINER_APP_NAME}" \
  --only-show-errors \
  --output none 2>/dev/null; then
  mark_release_searxng_mutated
  az containerapp update --yaml "${searxng_manifest}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${SEARXNG_CONTAINER_APP_NAME}" \
    --only-show-errors \
    --output none
else
  mark_release_searxng_mutated
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

BOT_MANIFEST_TEMPLATE="${bot_manifest_template}" \
BOT_MANIFEST="${bot_manifest}" \
CONTAINER_APP_NAME="${CONTAINER_APP_NAME}" \
MANAGED_ENVIRONMENT_ID="${managed_environment_id}" \
CONTAINER_APP_LOCATION="${container_app_location}" \
BOT_IMAGE="${image_ref}" \
SEARXNG_BASE_URL="${searxng_base_url}" \
AZURE_OPENAI_EMBEDDING_ENDPOINT="${azure_openai_embedding_endpoint}" \
AZURE_OPENAI_EMBEDDING_DEPLOYMENT="${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}" \
AZURE_OPENAI_EMBEDDING_API_VERSION="${AZURE_OPENAI_EMBEDDING_API_VERSION}" \
BOT_ENV_JSON="${bot_env_json}" \
python3 - <<'PY'
from pathlib import Path
import json
import os

env_values = {
    item["name"]: item.get("value")
    for item in json.loads(os.environ["BOT_ENV_JSON"])
    if item.get("name")
}
source_env_names = [
    "LINE_HELPER_ACCOUNT_ID",
    "LINE_MAIN_ACCOUNT_ID",
    "LINE_ACCOUNT_PROVIDER_ID",
    "GRAPH_TENANT_ID",
    "GRAPH_CLIENT_ID",
    "GRAPH_DRIVE_ID",
    "GRAPH_PPT_FOLDER_ITEM_ID",
    "GRAPH_POP_SHEET_FOLDER_ITEM_ID",
    "GRAPH_POP_SHEET_DRIVE_ID",
    "GRAPH_HYMN_SHEET_FOLDER_ITEM_ID",
    "GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID",
    "GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID",
    "GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID",
    "NOTION_SERVICE_DATABASE_ID",
    "NOTION_DATE_PROPERTY",
    "NOTION_MEETING_PROPERTY",
    "NOTION_ROLE_PROPERTY",
    "NOTION_PERSON_PROPERTY",
]
for name in source_env_names:
    if env_values.get(name) is None:
        raise SystemExit(f"Required ACA environment reference is unavailable: {name}")

substitutions = {
    "PLACEHOLDER_CONTAINER_APP_NAME": os.environ["CONTAINER_APP_NAME"],
    "PLACEHOLDER_CONTAINER_APP_ENVIRONMENT_ID": os.environ["MANAGED_ENVIRONMENT_ID"],
    "PLACEHOLDER_AZURE_REGION": os.environ["CONTAINER_APP_LOCATION"],
    "PLACEHOLDER_BOT_IMAGE": os.environ["BOT_IMAGE"],
    "PLACEHOLDER_SEARXNG_BASE_URL": os.environ["SEARXNG_BASE_URL"],
    "PLACEHOLDER_AZURE_OPENAI_EMBEDDING_ENDPOINT": os.environ[
        "AZURE_OPENAI_EMBEDDING_ENDPOINT"
    ],
    "PLACEHOLDER_AZURE_OPENAI_EMBEDDING_DEPLOYMENT": os.environ[
        "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"
    ],
    "PLACEHOLDER_AZURE_OPENAI_EMBEDDING_API_VERSION": os.environ[
        "AZURE_OPENAI_EMBEDDING_API_VERSION"
    ],
    "PLACEHOLDER_ATTACHMENT_SCAN_QUEUE_URL_SECRET_REF": "attachment-scan-queue-url",
    "PLACEHOLDER_LINE_HELPER_CHANNEL_SECRET_REF": "line-helper-channel-secret",
    "PLACEHOLDER_LINE_HELPER_CHANNEL_ACCESS_TOKEN_SECRET_REF": (
        "line-helper-channel-access-token"
    ),
    "PLACEHOLDER_LINE_MAIN_CHANNEL_SECRET_REF": "line-main-channel-secret",
    "PLACEHOLDER_LINE_MAIN_CHANNEL_ACCESS_TOKEN_SECRET_REF": (
        "line-main-channel-access-token"
    ),
    "PLACEHOLDER_AZURE_OPENAI_EMBEDDING_API_KEY_SECRET_REF": (
        "azure-openai-embedding-key"
    ),
    "PLACEHOLDER_DEEPSEEK_API_KEY_SECRET_REF": "deepseek-api-key",
    "PLACEHOLDER_OBSERVABILITY_HMAC_KEY_SECRET_REF": "observability-hmac-key",
    "PLACEHOLDER_DATABASE_URL_SECRET_REF": "database-url",
    "PLACEHOLDER_REDIS_URL_SECRET_REF": "redis-url",
    "PLACEHOLDER_GRAPH_CLIENT_SECRET_REF": "graph-client-secret",
    "PLACEHOLDER_NOTION_TOKEN_SECRET_REF": "notion-token",
}
substitutions.update(
    {f"PLACEHOLDER_{name}": env_values[name] for name in source_env_names}
)

text = Path(os.environ["BOT_MANIFEST_TEMPLATE"]).read_text()
for placeholder, value in substitutions.items():
    if text.count(placeholder) != 1:
        raise SystemExit(f"Expected one bot manifest placeholder: {placeholder}")
    text = text.replace(placeholder, json.dumps(value, ensure_ascii=False))
if "PLACEHOLDER_" in text:
    raise SystemExit("A bot manifest placeholder was not resolved")
Path(os.environ["BOT_MANIFEST"]).write_text(text)
PY

mark_release_mutated
az containerapp update \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --yaml "${bot_manifest}" \
  --only-show-errors \
  --output none

target_revision="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "properties.latestRevisionName" \
  --output tsv)"
RELEASE_TARGET_REVISION="${target_revision}"
RELEASE_TARGET_IMAGE="${image_ref}"
RELEASE_TARGET_SCAN_IMAGE="${scan_image_ref}"
RELEASE_TARGET_ATTACHMENT_IMAGE="${image_ref}"

bot_fqdn="$(az containerapp show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --query "properties.configuration.ingress.fqdn" \
  --output tsv \
  --only-show-errors)"
if [[ -z "${bot_fqdn}" ]]; then
  echo "Could not resolve the release assurance endpoint contract" >&2
  exit 1
fi
bot_base_url="https://${bot_fqdn}"
gateway_webhook_url="${PUBLIC_WEB_ORIGIN%/}/api/line/webhook/helper"
gateway_main_webhook_url="${PUBLIC_WEB_ORIGIN%/}/api/line/webhook/main"

retired_bot_secrets=(
  bot-profiles-base64-json
  attachment-scan-queue-connection-string
  clamav-signature-storage-key
  openai-api-key
)
for retired_bot_secret in "${retired_bot_secrets[@]}"; do
  retired_bot_secret_name="$(az containerapp secret list \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${CONTAINER_APP_NAME}" \
    --query "[?name=='${retired_bot_secret}'].name | [0]" \
    --output tsv)"
  if [[ -n "${retired_bot_secret_name}" ]]; then
    az containerapp secret remove \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${CONTAINER_APP_NAME}" \
      --secret-names "${retired_bot_secret}" \
      --only-show-errors \
      --output none
  fi
done

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
  CONTAINER_APP_JOB_IDENTITY_ID="${container_app_job_identity_id}" \
  ATTACHMENT_JOB_IDENTITY_ID="${attachment_job_identity_id}" \
  ATTACHMENT_JOB_CLIENT_ID="${attachment_job_client_id}" \
  ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME="${ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME}" \
  ATTACHMENT_SCAN_QUEUE_NAME="${ATTACHMENT_SCAN_QUEUE_NAME}" \
  ASSET_API_URL="${asset_api_url}" \
  ASSET_API_AUDIENCE="${ASSET_API_AUDIENCE}" \
  BOT_SECRETS_JSON="${bot_secrets_json}" \
  BOT_ENV_JSON="${bot_env_json}" \
  ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING="${attachment_scan_queue_connection_string}" \
  BOT_BASE_URL="${bot_base_url}" \
  SEARXNG_BASE_URL="${searxng_base_url}" \
  GATEWAY_WEBHOOK_URL="${gateway_webhook_url}" \
  GATEWAY_MAIN_WEBHOOK_URL="${gateway_main_webhook_url}" \
  python3 - <<'PY'
from pathlib import Path
import base64
import hashlib
import hmac
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
main_signature_placeholder = "PLACEHOLDER_LINE_MAIN_EMPTY_WEBHOOK_SIGNATURE"
if main_signature_placeholder in text:
    if text.count(main_signature_placeholder) != 1:
        raise SystemExit(
            f"Expected one assurance job placeholder: {main_signature_placeholder}"
        )
    main_secret = secret_values.get("line-main-channel-secret")
    if not main_secret:
        raise SystemExit("Required ACA secret is unavailable: line-main-channel-secret")
    main_signature = base64.b64encode(
        hmac.new(main_secret.encode("utf-8"), b'{"events":[]}', hashlib.sha256).digest()
    ).decode("ascii")
    text = text.replace(main_signature_placeholder, main_signature)
substitutions = {
    "PLACEHOLDER_CONTAINER_APP_ENVIRONMENT_ID": os.environ["MANAGED_ENVIRONMENT_ID"],
    "PLACEHOLDER_AZURE_REGION": os.environ["CONTAINER_APP_LOCATION"],
    "PLACEHOLDER_CONTAINER_APP_JOB_IDENTITY_ID": os.environ[
        "CONTAINER_APP_JOB_IDENTITY_ID"
    ],
    "PLACEHOLDER_ATTACHMENT_JOB_IDENTITY_ID": os.environ[
        "ATTACHMENT_JOB_IDENTITY_ID"
    ],
    "PLACEHOLDER_ATTACHMENT_JOB_CLIENT_ID": os.environ[
        "ATTACHMENT_JOB_CLIENT_ID"
    ],
    "PLACEHOLDER_ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME": os.environ[
        "ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME"
    ],
    "PLACEHOLDER_ATTACHMENT_SCAN_QUEUE_NAME": os.environ["ATTACHMENT_SCAN_QUEUE_NAME"],
    "PLACEHOLDER_ASSET_API_URL": os.environ["ASSET_API_URL"],
    "PLACEHOLDER_ASSET_API_AUDIENCE": os.environ["ASSET_API_AUDIENCE"],
    "PLACEHOLDER_ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING": os.environ[
        "ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING"
    ],
    "PLACEHOLDER_BOT_BASE_URL": os.environ["BOT_BASE_URL"],
    "PLACEHOLDER_SEARXNG_BASE_URL": os.environ["SEARXNG_BASE_URL"],
    "PLACEHOLDER_GATEWAY_WEBHOOK_URL": os.environ["GATEWAY_WEBHOOK_URL"],
    "PLACEHOLDER_GATEWAY_MAIN_WEBHOOK_URL": os.environ["GATEWAY_MAIN_WEBHOOK_URL"],
}
strict_assurance_placeholders = {
    "PLACEHOLDER_BOT_BASE_URL",
    "PLACEHOLDER_SEARXNG_BASE_URL",
    "PLACEHOLDER_GATEWAY_WEBHOOK_URL",
    "PLACEHOLDER_GATEWAY_MAIN_WEBHOOK_URL",
}
for placeholder, value in substitutions.items():
    if placeholder in strict_assurance_placeholders and placeholder in text:
        if text.count(placeholder) != 1:
            raise SystemExit(f"Expected one assurance job placeholder: {placeholder}")
    text = text.replace(placeholder, value)
if "PLACEHOLDER_" in text:
    raise SystemExit("A job manifest placeholder was not resolved")
Path(os.environ["JOB_MANIFEST_RENDERED"]).write_text(text)
PY
}

deploy_job() {
  local job_name="$1"
  local manifest_path="$2"
  local user_assigned_identity="${3:-}"
  if az containerapp job show \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${job_name}" \
    --only-show-errors \
    --output none 2>/dev/null; then
    if [[ -n "${user_assigned_identity}" ]]; then
      az containerapp job identity assign \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${job_name}" \
        --user-assigned "${user_assigned_identity}" \
        --only-show-errors \
        --output none
    fi
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

start_release_job() {
  local job_name="$1"
  local check_name="$2"
  local failure_reason="$3"
  local execution_name
  if ! execution_name="$(
    az containerapp job start \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${job_name}" \
      --query name \
      --output tsv \
      --only-show-errors
  )" || [[ -z "${execution_name}" ]]; then
    fail_release_check "${check_name}" "${failure_reason}" network_failed
    return 1
  fi
  RELEASE_STARTED_EXECUTION_NAME="${execution_name}"
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
  "${image_ref}"
render_job_manifest \
  "${catalog_job_manifest_template}" \
  "${catalog_job_manifest}" \
  "${CATALOG_SYNC_JOB_NAME}" \
  "${image_ref}"
render_job_manifest \
  "${release_probe_job_manifest_template}" \
  "${release_probe_job_manifest}" \
  "${RELEASE_PROBE_JOB_NAME}" \
  "${image_ref}"
render_job_manifest \
  "${periodic_assurance_job_manifest_template}" \
  "${periodic_assurance_job_manifest}" \
  "${PERIODIC_ASSURANCE_JOB_NAME}" \
  "${scan_image_ref}"

mark_release_job_mutated "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}"
deploy_job "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" "${clamav_refresh_job_manifest}"
start_release_job \
  "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" \
  clamav_refresh_job \
  clamav_bootstrap_start_failed
RELEASE_CLAMAV_BOOTSTRAP_EXECUTION_NAME="${RELEASE_STARTED_EXECUTION_NAME}"
mark_release_job_mutated "${ATTACHMENT_SCAN_JOB_NAME}"
deploy_job "${ATTACHMENT_SCAN_JOB_NAME}" "${attachment_scan_job_manifest}" "${attachment_job_identity_id}"
start_release_job \
  "${ATTACHMENT_SCAN_JOB_NAME}" \
  attachment_scan_job \
  attachment_bootstrap_start_failed
RELEASE_ATTACHMENT_BOOTSTRAP_EXECUTION_NAME="${RELEASE_STARTED_EXECUTION_NAME}"
mark_release_job_mutated "${CATALOG_SYNC_JOB_NAME}"
deploy_job "${CATALOG_SYNC_JOB_NAME}" "${catalog_job_manifest}"
mark_release_job_mutated "${RELEASE_PROBE_JOB_NAME}"
deploy_job "${RELEASE_PROBE_JOB_NAME}" "${release_probe_job_manifest}"
mark_release_job_mutated "${PERIODIC_ASSURANCE_JOB_NAME}"
deploy_job \
  "${PERIODIC_ASSURANCE_JOB_NAME}" \
  "${periodic_assurance_job_manifest}" \
  "${attachment_job_identity_id}"

run_release_gates
write_release_report
complete_release_transaction

echo "Deployed ${image_ref} to revision ${target_revision}"
