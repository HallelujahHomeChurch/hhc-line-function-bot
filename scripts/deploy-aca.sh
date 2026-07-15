#!/usr/bin/env bash

set -euo pipefail

: "${ACR_NAME:?ACR_NAME is required}"
: "${ACR_LOGIN_SERVER:?ACR_LOGIN_SERVER is required}"
: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${CONTAINER_APP_NAME:?CONTAINER_APP_NAME is required}"
: "${CATALOG_SYNC_JOB_NAME:?CATALOG_SYNC_JOB_NAME is required}"

image_ref="${ACR_LOGIN_SERVER}/${IMAGE_REPOSITORY}:${IMAGE_TAG}"
echo "Deploying ${image_ref} to ${CONTAINER_APP_NAME}"

legacy_profile_envs=()
for env_name in BOT_PROFILES_BASE64_JSON BOT_PROFILES_JSON PROFILE_CONFIG_VERSION PPT_ALLOWED_EXTENSIONS PPT_DEFAULT_INCLUDE_PDF GRAPH_SHEET_MUSIC_FOLDER_ITEM_ID GRAPH_SHEET_MUSIC_FOLDER_PATH SHEET_MUSIC_DEFAULT_RECURSIVE; do
  value="$(az containerapp show \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${CONTAINER_APP_NAME}" \
    --query "properties.template.containers[0].env[?name=='${env_name}'].name | [0]" \
    --output tsv)"
  if [[ -n "${value}" ]]; then
    legacy_profile_envs+=("${env_name}")
  fi
done

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
  "EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS=15000"
  "EXTERNAL_RESOURCE_MAX_REDIRECTS=3"
  "SHEET_MUSIC_ALLOWED_EXTENSIONS=pdf,jpg,jpeg,png"
  "SEARXNG_BASE_URL=http://172.16.65.5:8888"
  "SEARXNG_TIMEOUT_MS=8000"
  "CLAMAV_HOST=172.16.65.5"
  "CLAMAV_PORT=3310"
  "CLAMAV_TIMEOUT_MS=15000"
  "OLLAMA_EMBEDDING_MODEL=bge-m3"
  "EMBEDDING_BATCH_SIZE=16"
  "EMBEDDING_TIMEOUT_MS=30000"
  "EMBEDDING_KEEP_ALIVE=1m"
)
if [[ ${#legacy_profile_envs[@]} -gt 0 ]]; then
  update_args+=(--remove-env-vars "${legacy_profile_envs[@]}")
fi

az containerapp update "${update_args[@]}" \
  --only-show-errors \
  --output none

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

subscription_id="$(az account show --query id --output tsv)"
ollama_base_url="$(az rest \
  --method post \
  --uri "https://management.azure.com/subscriptions/${subscription_id}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/containerApps/${CONTAINER_APP_NAME}/listSecrets?api-version=2024-03-01" \
  --query "value[?name=='ollama-base-url'].value | [0]" \
  --output tsv)"
if [[ -z "${ollama_base_url}" ]]; then
  echo "Missing ollama-base-url app secret"
  exit 1
fi
az containerapp job secret set \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CATALOG_SYNC_JOB_NAME}" \
  --secrets "ollama-base-url=${ollama_base_url}" \
  --only-show-errors \
  --output none
unset ollama_base_url
az containerapp job update \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CATALOG_SYNC_JOB_NAME}" \
  --container-name catalog-sync \
  --image "${image_ref}" \
  --set-env-vars \
    "OLLAMA_BASE_URL=secretref:ollama-base-url" \
    "OLLAMA_EMBEDDING_MODEL=bge-m3" \
    "EMBEDDING_BATCH_SIZE=16" \
    "EMBEDDING_TIMEOUT_MS=30000" \
    "EMBEDDING_KEEP_ALIVE=1m" \
  --only-show-errors \
  --output none

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

echo "Deployed ${image_ref} to revision ${target_revision}"
