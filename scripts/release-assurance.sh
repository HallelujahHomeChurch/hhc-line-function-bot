#!/usr/bin/env bash

# Sourced by deploy-aca.sh. The caller owns `set -euo pipefail`.

: "${RELEASE_POLL_ATTEMPTS:=30}"
: "${RELEASE_POLL_INTERVAL_SECONDS:=10}"

RELEASE_STARTED_AT="${RELEASE_STARTED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")}"
RELEASE_MUTATED="${RELEASE_MUTATED:-false}"
RELEASE_TRANSACTION_COMPLETE="${RELEASE_TRANSACTION_COMPLETE:-false}"
RELEASE_REPORT_WRITTEN="${RELEASE_REPORT_WRITTEN:-false}"
RELEASE_FAILURE_REASON="${RELEASE_FAILURE_REASON:-none}"
RELEASE_CHECK_RECORDS="${RELEASE_CHECK_RECORDS:-}"
RELEASE_ROLLBACK_STATUS="${RELEASE_ROLLBACK_STATUS:-not_required}"
RELEASE_ROLLBACK_REVISION="${RELEASE_ROLLBACK_REVISION:-}"
RELEASE_ROLLBACK_IMAGE="${RELEASE_ROLLBACK_IMAGE:-}"
RELEASE_CATALOG_JOB_MUTATED="${RELEASE_CATALOG_JOB_MUTATED:-false}"
RELEASE_SCAN_JOB_MUTATED="${RELEASE_SCAN_JOB_MUTATED:-false}"
RELEASE_REFRESH_JOB_MUTATED="${RELEASE_REFRESH_JOB_MUTATED:-false}"
RELEASE_PROBE_JOB_MUTATED="${RELEASE_PROBE_JOB_MUTATED:-false}"
RELEASE_PERIODIC_JOB_MUTATED="${RELEASE_PERIODIC_JOB_MUTATED:-false}"
RELEASE_SEARXNG_MUTATED="${RELEASE_SEARXNG_MUTATED:-false}"
RELEASE_PROVIDER_CONTRACT_VERIFIED=false
RELEASE_CLEANUP_FILES=()

set_release_failure() {
  local reason="$1"
  if [[ "${RELEASE_FAILURE_REASON}" == "none" ]]; then
    RELEASE_FAILURE_REASON="${reason}"
  fi
}

record_release_check() {
  local name="$1"
  local status="$2"
  local code="$3"
  local observed_at
  observed_at="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  RELEASE_CHECK_RECORDS+="${name}|${status}|${observed_at}|${code}"$'\n'
}

fail_release_check() {
  local name="$1"
  local reason="$2"
  local report_code="$3"
  record_release_check "${name}" failed "${report_code}"
  set_release_failure "${reason}"
  return 1
}

capture_known_good_state() {
  : "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
  : "${CONTAINER_APP_NAME:?CONTAINER_APP_NAME is required}"
  : "${CATALOG_SYNC_JOB_NAME:?CATALOG_SYNC_JOB_NAME is required}"
  : "${ATTACHMENT_SCAN_JOB_NAME:?ATTACHMENT_SCAN_JOB_NAME is required}"
  : "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME:?CLAMAV_SIGNATURE_REFRESH_JOB_NAME is required}"
  : "${RELEASE_PROBE_JOB_NAME:?RELEASE_PROBE_JOB_NAME is required}"
  : "${PERIODIC_ASSURANCE_JOB_NAME:?PERIODIC_ASSURANCE_JOB_NAME is required}"
  : "${SEARXNG_CONTAINER_APP_NAME:?SEARXNG_CONTAINER_APP_NAME is required}"

  if ! RELEASE_KNOWN_GOOD_REVISION="$(
    az containerapp show \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${CONTAINER_APP_NAME}" \
      --query "properties.latestReadyRevisionName" \
      --output tsv \
      --only-show-errors
  )" || [[ -z "${RELEASE_KNOWN_GOOD_REVISION}" ]]; then
    set_release_failure known_good_snapshot_failed
    return 1
  fi
  if ! RELEASE_KNOWN_GOOD_IMAGE_RAW="$(
    az containerapp revision show \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${CONTAINER_APP_NAME}" \
      --revision "${RELEASE_KNOWN_GOOD_REVISION}" \
      --query "properties.template.containers[0].image" \
      --output tsv \
      --only-show-errors
  )" || [[ -z "${RELEASE_KNOWN_GOOD_IMAGE_RAW}" ]] \
    || ! RELEASE_KNOWN_GOOD_IMAGE="$(resolve_release_image "${RELEASE_KNOWN_GOOD_IMAGE_RAW}")"; then
    set_release_failure known_good_snapshot_failed
    return 1
  fi

  if ! capture_release_job_snapshot CATALOG "${CATALOG_SYNC_JOB_NAME}" \
    || ! capture_release_job_snapshot SCAN "${ATTACHMENT_SCAN_JOB_NAME}" \
    || ! capture_release_job_snapshot REFRESH "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" \
    || ! capture_release_job_snapshot PROBE "${RELEASE_PROBE_JOB_NAME}" \
    || ! capture_release_job_snapshot PERIODIC "${PERIODIC_ASSURANCE_JOB_NAME}"; then
    set_release_failure known_good_snapshot_failed
    return 1
  fi
  local searxng_exists
  if ! searxng_exists="$(release_containerapp_exists "${SEARXNG_CONTAINER_APP_NAME}")"; then
    set_release_failure known_good_snapshot_failed
    return 1
  fi
  if [[ "${searxng_exists}" == "true" ]]; then
    if ! RELEASE_KNOWN_GOOD_SEARXNG_REVISION="$(
      az containerapp show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${SEARXNG_CONTAINER_APP_NAME}" \
        --query properties.latestReadyRevisionName \
        --output tsv \
        --only-show-errors
    )"; then
      set_release_failure known_good_snapshot_failed
      return 1
    fi
    if [[ -z "${RELEASE_KNOWN_GOOD_SEARXNG_REVISION}" ]]; then
      set_release_failure known_good_snapshot_failed
      return 1
    fi
    RELEASE_KNOWN_GOOD_SEARXNG_EXISTS=true
    if ! RELEASE_KNOWN_GOOD_SEARXNG_IMAGE="$(
      az containerapp revision show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${SEARXNG_CONTAINER_APP_NAME}" \
        --revision "${RELEASE_KNOWN_GOOD_SEARXNG_REVISION}" \
        --query properties.template.containers[0].image \
        --output tsv \
        --only-show-errors
    )" || [[ -z "${RELEASE_KNOWN_GOOD_SEARXNG_IMAGE}" ]] \
      || ! RELEASE_KNOWN_GOOD_SEARXNG_IMAGE="$(
        resolve_release_image "${RELEASE_KNOWN_GOOD_SEARXNG_IMAGE}"
      )"; then
      set_release_failure known_good_snapshot_failed
      return 1
    fi
  else
    RELEASE_KNOWN_GOOD_SEARXNG_EXISTS=false
    RELEASE_KNOWN_GOOD_SEARXNG_REVISION=""
    RELEASE_KNOWN_GOOD_SEARXNG_IMAGE=""
  fi
}

resolve_release_image() {
  local image="$1"
  local digest
  local repository_and_tag
  local repository
  if [[ "${image}" =~ ^([^@]+)@sha256:([a-f0-9]{64})$ ]]; then
    printf '%s\n' "${image}"
    return 0
  fi
  if [[ "${image}" != "${ACR_LOGIN_SERVER}/"* ]]; then
    return 1
  fi
  repository_and_tag="${image#"${ACR_LOGIN_SERVER}/"}"
  if [[ "${repository_and_tag}" != *:* ]]; then
    return 1
  fi
  repository="${repository_and_tag%:*}"
  if ! digest="$(
    az acr manifest show-metadata \
      --registry "${ACR_NAME}" \
      --name "${repository_and_tag}" \
      --query digest \
      --output tsv \
      --only-show-errors
  )" || [[ ! "${digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    return 1
  fi
  printf '%s/%s@%s\n' "${ACR_LOGIN_SERVER}" "${repository}" "${digest}"
}

capture_release_job_snapshot() {
  local key="$1"
  local job_name="$2"
  local exists
  local image
  local manifest_json
  local manifest_path
  if ! exists="$(release_job_exists "${job_name}")"; then
    return 1
  fi
  if [[ "${exists}" == "true" ]]; then
    if ! image="$(release_job_image "${job_name}")"; then
      return 1
    fi
    if [[ -z "${image}" ]]; then
      return 1
    fi
    printf -v "RELEASE_KNOWN_GOOD_${key}_EXISTS" '%s' true
    if ! image="$(resolve_release_image "${image}")"; then
      return 1
    fi
    if ! manifest_json="$(release_job_manifest_json "${job_name}")"; then
      return 1
    fi
    manifest_path="$(mktemp)"
    RELEASE_CLEANUP_FILES+=("${manifest_path}")
    if ! normalize_release_job_manifest "${manifest_json}" "${image}" "${manifest_path}"; then
      return 1
    fi
    printf -v "RELEASE_KNOWN_GOOD_${key}_IMAGE" '%s' "${image}"
    printf -v "RELEASE_KNOWN_GOOD_${key}_MANIFEST" '%s' "${manifest_path}"
  else
    printf -v "RELEASE_KNOWN_GOOD_${key}_EXISTS" '%s' false
    printf -v "RELEASE_KNOWN_GOOD_${key}_IMAGE" '%s' ""
    printf -v "RELEASE_KNOWN_GOOD_${key}_MANIFEST" '%s' ""
  fi
}

release_containerapp_exists() {
  local app_name="$1"
  local observed
  if ! observed="$(
    az containerapp list \
      --resource-group "${RESOURCE_GROUP}" \
      --query "[?name=='${app_name}'].name | [0]" \
      --output tsv \
      --only-show-errors
  )"; then
    return 1
  fi
  [[ -n "${observed}" ]] && printf 'true\n' || printf 'false\n'
}

release_job_exists() {
  local job_name="$1"
  local observed
  if ! observed="$(
    az containerapp job list \
      --resource-group "${RESOURCE_GROUP}" \
      --query "[?name=='${job_name}'].name | [0]" \
      --output tsv \
      --only-show-errors
  )"; then
    return 1
  fi
  [[ -n "${observed}" ]] && printf 'true\n' || printf 'false\n'
}

release_job_image() {
  local job_name="$1"
  az containerapp job show \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${job_name}" \
    --query "properties.template.containers[0].image" \
    --output tsv \
    --only-show-errors
}

release_job_manifest_json() {
  local job_name="$1"
  az containerapp job show \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${job_name}" \
    --query "{name:name,type:type,location:location,identity:{type:identity.type,userAssignedIdentities:identity.userAssignedIdentities},properties:{environmentId:properties.environmentId,configuration:{registries:properties.configuration.registries,triggerType:properties.configuration.triggerType,replicaTimeout:properties.configuration.replicaTimeout,replicaRetryLimit:properties.configuration.replicaRetryLimit,scheduleTriggerConfig:properties.configuration.scheduleTriggerConfig,eventTriggerConfig:properties.configuration.eventTriggerConfig,manualTriggerConfig:properties.configuration.manualTriggerConfig},template:properties.template}}" \
    --output json \
    --only-show-errors
}

normalize_release_job_manifest() {
  local manifest_json="$1"
  local image="$2"
  local destination="$3"
  RELEASE_JOB_MANIFEST_JSON="${manifest_json}" \
  RELEASE_JOB_MANIFEST_IMAGE="${image}" \
  RELEASE_JOB_MANIFEST_DESTINATION="${destination}" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

value = json.loads(os.environ["RELEASE_JOB_MANIFEST_JSON"])
if not isinstance(value, dict):
    raise SystemExit(1)
properties = value.get("properties")
template = properties.get("template") if isinstance(properties, dict) else None
containers = template.get("containers") if isinstance(template, dict) else None
if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
    raise SystemExit(1)
containers[0]["image"] = os.environ["RELEASE_JOB_MANIFEST_IMAGE"]
identity = value.get("identity")
if isinstance(identity, dict):
    normalized_identity = {}
    if identity.get("type") is not None:
        normalized_identity["type"] = identity["type"]
    user_assigned = identity.get("userAssignedIdentities")
    if isinstance(user_assigned, dict):
        normalized_identity["userAssignedIdentities"] = {
            resource_id: {} for resource_id in user_assigned
        }
    value["identity"] = normalized_identity
Path(os.environ["RELEASE_JOB_MANIFEST_DESTINATION"]).write_text(
    json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
}

mark_release_mutated() {
  RELEASE_MUTATED=true
}

mark_release_searxng_mutated() {
  RELEASE_SEARXNG_MUTATED=true
  mark_release_mutated
}

mark_release_job_mutated() {
  local job_name="$1"
  case "${job_name}" in
    "${CATALOG_SYNC_JOB_NAME}")
      RELEASE_CATALOG_JOB_MUTATED=true
      ;;
    "${ATTACHMENT_SCAN_JOB_NAME}")
      RELEASE_SCAN_JOB_MUTATED=true
      ;;
    "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}")
      RELEASE_REFRESH_JOB_MUTATED=true
      ;;
    "${RELEASE_PROBE_JOB_NAME}")
      RELEASE_PROBE_JOB_MUTATED=true
      ;;
    "${PERIODIC_ASSURANCE_JOB_NAME}")
      RELEASE_PERIODIC_JOB_MUTATED=true
      ;;
    *)
      set_release_failure unexpected_release_job
      return 1
      ;;
  esac
}

complete_release_transaction() {
  if [[ "${RELEASE_REPORT_WRITTEN}" != "true" ]]; then
    set_release_failure report_write_failed
    return 1
  fi
  RELEASE_TRANSACTION_COMPLETE=true
}

run_release_gates() {
  RELEASE_PROVIDER_CONTRACT_VERIFIED=false
  : "${SEARXNG_CONTAINER_APP_NAME:?SEARXNG_CONTAINER_APP_NAME is required}"
  : "${RELEASE_PROBE_JOB_NAME:?RELEASE_PROBE_JOB_NAME is required}"
  : "${PERIODIC_ASSURANCE_JOB_NAME:?PERIODIC_ASSURANCE_JOB_NAME is required}"
  : "${RELEASE_TARGET_REVISION:?RELEASE_TARGET_REVISION is required}"
  : "${RELEASE_TARGET_IMAGE:?RELEASE_TARGET_IMAGE is required}"
  : "${RELEASE_TARGET_SCAN_IMAGE:?RELEASE_TARGET_SCAN_IMAGE is required}"
  : "${RELEASE_EXPECTED_SEARXNG_IMAGE:?RELEASE_EXPECTED_SEARXNG_IMAGE is required}"
  : "${RELEASE_CLAMAV_BOOTSTRAP_EXECUTION_NAME:?RELEASE_CLAMAV_BOOTSTRAP_EXECUTION_NAME is required}"

  release_wait_for_target || return
  release_check_searxng || return
  release_check_job_definition \
    "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" Schedule 900 1 schedule \
    "${RELEASE_TARGET_SCAN_IMAGE}" clamav_refresh_job refresh_definition_mismatch false || return
  release_check_job_definition \
    "${ATTACHMENT_SCAN_JOB_NAME}" Event 900 1 event \
    "${RELEASE_TARGET_SCAN_IMAGE}" attachment_scan_job scan_definition_mismatch || return
  release_check_job_definition \
    "${CATALOG_SYNC_JOB_NAME}" Schedule 600 1 schedule \
    "${RELEASE_TARGET_IMAGE}" catalog_job catalog_definition_mismatch false || return
  release_check_job_definition \
    "${RELEASE_PROBE_JOB_NAME}" Manual 300 0 manual \
    "${RELEASE_TARGET_IMAGE}" release_probe release_probe_definition_mismatch false || return
  release_check_job_definition \
    "${PERIODIC_ASSURANCE_JOB_NAME}" Manual 600 0 manual \
    "${RELEASE_TARGET_SCAN_IMAGE}" periodic_assurance_job periodic_definition_mismatch || return
  RELEASE_PROVIDER_CONTRACT_VERIFIED=true
  release_wait_for_job_execution \
    "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" \
    "${RELEASE_CLAMAV_BOOTSTRAP_EXECUTION_NAME}" \
    clamav_refresh_job clamav_bootstrap_failed clamav_manifest_invalid || return
  release_check_recent_catalog_success || return
  release_run_probe || return
}

release_wait_for_target() {
  local attempt
  local state_json
  local observed_image
  local outcome
  for ((attempt = 1; attempt <= RELEASE_POLL_ATTEMPTS; attempt += 1)); do
    if ! state_json="$(
      az containerapp show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${CONTAINER_APP_NAME}" \
        --query "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,transport:properties.configuration.ingress.transport,dapr:properties.configuration.dapr}" \
        --output json \
        --only-show-errors
    )"; then
      fail_release_check target_revision target_state_unavailable network_failed
      return
    fi
    if ! observed_image="$(
      az containerapp revision show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${CONTAINER_APP_NAME}" \
        --revision "${RELEASE_TARGET_REVISION}" \
        --query "properties.template.containers[0].image" \
        --output tsv \
        --only-show-errors
    )"; then
      outcome=target_revision_mismatch
    else
      outcome="$(
        RELEASE_BOT_STATE="${state_json}" \
        RELEASE_OBSERVED_IMAGE="${observed_image}" \
        RELEASE_EXPECTED_REVISION="${RELEASE_TARGET_REVISION}" \
        RELEASE_EXPECTED_IMAGE="${RELEASE_TARGET_IMAGE}" \
        python3 - <<'PY'
import json
import os

state = json.loads(os.environ["RELEASE_BOT_STATE"])
revision = os.environ["RELEASE_EXPECTED_REVISION"]
if (
    state.get("latestRevision") != revision
    or state.get("latestReadyRevision") != revision
    or state.get("runningStatus") != "Running"
):
    print("target_revision_mismatch")
elif os.environ["RELEASE_OBSERVED_IMAGE"] != os.environ["RELEASE_EXPECTED_IMAGE"]:
    print("target_image_mismatch")
else:
    traffic = state.get("traffic")
    traffic_ok = (
        isinstance(traffic, list)
        and len(traffic) == 1
        and traffic[0].get("weight") == 100
        and (
            traffic[0].get("revisionName") == revision
            or traffic[0].get("latestRevision") is True
        )
    )
    dapr = state.get("dapr") or {}
    if not traffic_ok:
        print("target_traffic_mismatch")
    elif (
        state.get("external") is not False
        or state.get("targetPort") != 3000
        or str(state.get("transport") or "").lower() != "auto"
    ):
        print("bot_ingress_mismatch")
    elif (
        dapr.get("enabled") is not True
        or dapr.get("appId") != "hhc-line-function-bot"
        or dapr.get("appPort") != 3000
        or dapr.get("appProtocol") != "http"
    ):
        print("bot_dapr_mismatch")
    else:
        print("passed")
PY
      )"
    fi

    case "${outcome}" in
      passed)
        record_release_check target_revision passed none
        record_release_check target_traffic passed none
        record_release_check bot_ingress passed none
        record_release_check bot_dapr passed none
        return 0
        ;;
      target_revision_mismatch | target_image_mismatch)
        if ((attempt < RELEASE_POLL_ATTEMPTS)); then
          sleep "${RELEASE_POLL_INTERVAL_SECONDS}"
          continue
        fi
        ;;
      target_traffic_mismatch)
        fail_release_check target_traffic "${outcome}" http_mismatch
        return
        ;;
      bot_ingress_mismatch)
        fail_release_check bot_ingress "${outcome}" http_mismatch
        return
        ;;
      bot_dapr_mismatch)
        fail_release_check bot_dapr "${outcome}" http_mismatch
        return
        ;;
      *)
        fail_release_check target_revision malformed_target_state malformed_json
        return
        ;;
    esac
  done

  if [[ "${outcome}" == "target_image_mismatch" ]]; then
    fail_release_check target_revision "${outcome}" http_mismatch
  else
    fail_release_check target_revision "${outcome}" timeout
  fi
}

release_check_searxng() {
  local state_json
  if ! state_json="$(
    az containerapp show \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${SEARXNG_CONTAINER_APP_NAME}" \
      --query "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,transport:properties.configuration.ingress.transport,minReplicas:properties.template.scale.minReplicas,maxReplicas:properties.template.scale.maxReplicas,cpu:properties.template.containers[0].resources.cpu,memory:properties.template.containers[0].resources.memory,image:properties.template.containers[0].image}" \
      --output json \
      --only-show-errors
  )" || ! RELEASE_SEARXNG_STATE="${state_json}" \
    RELEASE_EXPECTED_SEARXNG_IMAGE="${RELEASE_EXPECTED_SEARXNG_IMAGE}" \
    python3 - <<'PY'
import json
import os

state = json.loads(os.environ["RELEASE_SEARXNG_STATE"])
image = state.get("image")
revision = state.get("latestRevision")
traffic = state.get("traffic")
traffic_ok = (
    isinstance(traffic, list)
    and len(traffic) == 1
    and traffic[0].get("weight") == 100
    and (
        traffic[0].get("revisionName") == revision
        or traffic[0].get("latestRevision") is True
    )
)
valid = (
    revision
    and revision == state.get("latestReadyRevision")
    and state.get("runningStatus") == "Running"
    and traffic_ok
    and state.get("external") is False
    and state.get("targetPort") == 8080
    and str(state.get("transport") or "").lower() == "http"
    and state.get("minReplicas") == 1
    and state.get("maxReplicas") == 1
    and state.get("cpu") == 0.25
    and state.get("memory") == "0.5Gi"
    and image == os.environ["RELEASE_EXPECTED_SEARXNG_IMAGE"]
)
raise SystemExit(0 if valid else 1)
PY
  then
    fail_release_check searxng_deployment searxng_definition_mismatch http_mismatch
    return
  fi
  record_release_check searxng_deployment passed none
}

release_check_job_definition() {
  local job_name="$1"
  local trigger_type="$2"
  local timeout="$3"
  local retry_limit="$4"
  local trigger_key="$5"
  local expected_image="$6"
  local check_name="$7"
  local failure_reason="$8"
  local record_on_pass="${9:-true}"
  local definition_json

  if ! definition_json="$(
    az containerapp job show \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${job_name}" \
      --query "{triggerType:properties.configuration.triggerType,replicaTimeout:properties.configuration.replicaTimeout,replicaRetryLimit:properties.configuration.replicaRetryLimit,schedule:properties.configuration.scheduleTriggerConfig,event:properties.configuration.eventTriggerConfig,manual:properties.configuration.manualTriggerConfig,image:properties.template.containers[0].image,args:properties.template.containers[0].args,env:properties.template.containers[0].env,resources:properties.template.containers[0].resources,volumeMounts:properties.template.containers[0].volumeMounts,volumes:properties.template.volumes}" \
      --output json \
      --only-show-errors
  )" || ! RELEASE_JOB_DEFINITION="${definition_json}" \
    RELEASE_EXPECTED_TRIGGER="${trigger_type}" \
    RELEASE_EXPECTED_TIMEOUT="${timeout}" \
    RELEASE_EXPECTED_RETRY="${retry_limit}" \
    RELEASE_EXPECTED_TRIGGER_KEY="${trigger_key}" \
    RELEASE_EXPECTED_JOB_IMAGE="${expected_image}" \
    RELEASE_JOB_CHECK_NAME="${check_name}" \
    python3 - <<'PY'
import json
import os

definition = json.loads(os.environ["RELEASE_JOB_DEFINITION"])
trigger = definition.get(os.environ["RELEASE_EXPECTED_TRIGGER_KEY"]) or {}
common_valid = (
    definition.get("triggerType") == os.environ["RELEASE_EXPECTED_TRIGGER"]
    and definition.get("replicaTimeout") == int(os.environ["RELEASE_EXPECTED_TIMEOUT"])
    and definition.get("replicaRetryLimit") == int(os.environ["RELEASE_EXPECTED_RETRY"])
    and trigger.get("parallelism") == 1
    and trigger.get("replicaCompletionCount") == 1
    and definition.get("image") == os.environ["RELEASE_EXPECTED_JOB_IMAGE"]
)
check_name = os.environ["RELEASE_JOB_CHECK_NAME"]
args = definition.get("args")
env = definition.get("env")
resources = definition.get("resources")
mounts = definition.get("volumeMounts")
volumes = definition.get("volumes")

expected_mounts = [
    {"volumeName": "clamav-signatures", "mountPath": "/var/lib/clamav"}
]
readonly_volumes = [
    {
        "name": "clamav-signatures",
        "storageType": "AzureFile",
        "storageName": "clamav-signatures-readonly",
    }
]
readwrite_volumes = [
    {
        "name": "clamav-signatures",
        "storageType": "AzureFile",
        "storageName": "clamav-signatures-readwrite",
    }
]

def env_contract(entries, expected):
    if not isinstance(entries, list) or len(entries) != len(expected):
        return False
    by_name = {
        entry.get("name"): entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }
    if set(by_name) != set(expected):
        return False
    if any(
        marker in name.upper()
        for name in by_name
        for marker in ("DEEPSEEK", "EMBEDDING", "OPENAI")
    ):
        return False
    return all(
        all(
            (
                isinstance(by_name[name].get(key), str)
                and bool(by_name[name].get(key))
                if value is None
                else by_name[name].get(key) == value
            )
            for key, value in contract.items()
        )
        and set(by_name[name]) == {"name", *contract.keys()}
        for name, contract in expected.items()
    )

valid = common_valid
if check_name == "catalog_job":
    hmac_env = [
        entry
        for entry in (env if isinstance(env, list) else [])
        if isinstance(entry, dict) and entry.get("name") == "OBSERVABILITY_HMAC_KEY"
    ]
    valid = (
        valid
        and trigger.get("cronExpression") == "*/15 * * * *"
        and args == ["dist/tools/sync-catalog.js"]
        and hmac_env
        == [
            {
                "name": "OBSERVABILITY_HMAC_KEY",
                "secretRef": "observability-hmac-key",
            }
        ]
    )
elif check_name == "clamav_refresh_job":
    valid = (
        valid
        and trigger.get("cronExpression") == "10 19 * * 0"
        and mounts == expected_mounts
        and volumes == readwrite_volumes
    )
elif check_name == "attachment_scan_job":
    scale = trigger.get("scale") or {}
    rules = scale.get("rules")
    rule = rules[0] if isinstance(rules, list) and len(rules) == 1 else {}
    valid = (
        valid
        and scale.get("minExecutions") == 0
        and scale.get("maxExecutions") == 1
        and rule.get("type") == "azure-queue"
        and rule.get("metadata", {}).get("queueLength") == "1"
        and rule.get("auth")
        == [
            {
                "triggerParameter": "connection",
                "secretRef": "attachment-scan-queue-connection-string",
            }
        ]
        and resources == {"cpu": 2, "memory": "4Gi"}
        and mounts == expected_mounts
        and volumes == readonly_volumes
    )
elif check_name == "release_probe":
    valid = (
        valid
        and args == ["dist/tools/run-release-probe.js"]
        and env_contract(
            env,
            {
                "BOT_BASE_URL": {"value": None},
                "SEARXNG_BASE_URL": {"value": None},
                "GATEWAY_WEBHOOK_URL": {"value": None},
                "LINE_HELPER_CHANNEL_SECRET": {
                    "secretRef": "line-helper-channel-secret"
                },
                "CLAMAV_SIGNATURE_MANIFEST_PATH": {
                    "value": "/var/lib/clamav/current/manifest.json"
                },
            },
        )
        and resources == {"cpu": 0.25, "memory": "0.5Gi"}
        and mounts == expected_mounts
        and volumes == readonly_volumes
    )
elif check_name == "periodic_assurance_job":
    valid = (
        valid
        and args == ["dist/tools/run-periodic-assurance.js"]
        and env_contract(
            env,
            {
                "GRAPH_TENANT_ID": {"value": None},
                "GRAPH_CLIENT_ID": {"value": None},
                "GRAPH_DRIVE_ID": {"value": None},
                "GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID": {"value": None},
                "NOTION_SERVICE_DATABASE_ID": {"value": None},
                "ATTACHMENT_SCAN_QUEUE_NAME": {"value": None},
                "GRAPH_CLIENT_SECRET": {"secretRef": "graph-client-secret"},
                "NOTION_TOKEN": {"secretRef": "notion-token"},
                "ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING": {
                    "secretRef": "attachment-scan-queue-connection-string"
                },
                "CLAMAV_SIGNATURE_MANIFEST_PATH": {
                    "value": "/var/lib/clamav/current/manifest.json"
                },
                "CLAMAV_SCAN_TIMEOUT_MS": {"value": "15000"},
            },
        )
        and resources == {"cpu": 0.25, "memory": "0.5Gi"}
        and mounts == expected_mounts
        and volumes == readonly_volumes
    )
else:
    valid = False
raise SystemExit(0 if valid else 1)
PY
  then
    fail_release_check "${check_name}" "${failure_reason}" http_mismatch
    return
  fi
  if [[ "${record_on_pass}" == "true" ]]; then
    record_release_check "${check_name}" passed none
  fi
}

release_wait_for_job_execution() {
  local job_name="$1"
  local execution_name="$2"
  local check_name="$3"
  local failure_reason="$4"
  local failure_code="$5"
  local attempt
  local status

  for ((attempt = 1; attempt <= RELEASE_POLL_ATTEMPTS; attempt += 1)); do
    if ! status="$(
      az containerapp job execution show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${job_name}" \
        --job-execution-name "${execution_name}" \
        --query "properties.status" \
        --output tsv \
        --only-show-errors
    )"; then
      fail_release_check "${check_name}" "${failure_reason}" network_failed
      return
    fi
    case "${status}" in
      Succeeded)
        record_release_check "${check_name}" passed none
        return 0
        ;;
      Failed | Stopped)
        fail_release_check "${check_name}" "${failure_reason}" "${failure_code}"
        return
        ;;
    esac
    if ((attempt < RELEASE_POLL_ATTEMPTS)); then
      sleep "${RELEASE_POLL_INTERVAL_SECONDS}"
    fi
  done
  fail_release_check "${check_name}" "${failure_reason}_timeout" timeout
}

release_check_recent_catalog_success() {
  local execution_json
  if ! execution_json="$(
    az containerapp job execution list \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${CATALOG_SYNC_JOB_NAME}" \
      --query "sort_by([?properties.status=='Succeeded'], &properties.startTime)[-1].{name:name,status:properties.status,startTime:properties.startTime}" \
      --output json \
      --only-show-errors
  )" || ! RELEASE_CATALOG_EXECUTION="${execution_json}" python3 - <<'PY'
from datetime import datetime, timezone
import json
import os

execution = json.loads(os.environ["RELEASE_CATALOG_EXECUTION"] or "null") or {}
try:
    started = datetime.fromisoformat(execution["startTime"].replace("Z", "+00:00"))
except (KeyError, TypeError, ValueError):
    raise SystemExit(1)
age = (datetime.now(timezone.utc) - started).total_seconds()
valid = execution.get("status") == "Succeeded" and -300 <= age <= 1800
raise SystemExit(0 if valid else 1)
PY
  then
    fail_release_check catalog_job catalog_recent_success_missing timeout
    return
  fi
  record_release_check catalog_job passed none
}

release_run_probe() {
  local execution_name
  local execution_status=""
  local probe_logs
  local parsed
  local name
  local status
  local code
  local payload_status=""
  local failure_reason=""
  if ! execution_name="$(
    az containerapp job start \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${RELEASE_PROBE_JOB_NAME}" \
      --query "name" \
      --output tsv \
      --only-show-errors
  )" || [[ -z "${execution_name}" ]]; then
    fail_release_check release_probe release_probe_start_failed network_failed
    return
  fi
  for ((attempt = 1; attempt <= RELEASE_POLL_ATTEMPTS; attempt += 1)); do
    if ! execution_status="$(
      az containerapp job execution show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${RELEASE_PROBE_JOB_NAME}" \
        --job-execution-name "${execution_name}" \
        --query "properties.status" \
        --output tsv \
        --only-show-errors
    )"; then
      fail_release_check release_probe release_probe_failed network_failed
      return
    fi
    case "${execution_status}" in
      Succeeded | Failed | Stopped)
        break
        ;;
      *)
        if ((attempt == RELEASE_POLL_ATTEMPTS)); then
          fail_release_check release_probe release_probe_failed_timeout timeout
          return
        fi
        sleep "${RELEASE_POLL_INTERVAL_SECONDS}"
        ;;
    esac
  done
  if ! probe_logs="$(
    az containerapp job logs show \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${RELEASE_PROBE_JOB_NAME}" \
      --execution "${execution_name}" \
      --container release-probe \
      --tail 20 \
      --format json \
      --only-show-errors
  )"; then
    fail_release_check release_probe release_probe_logs_failed network_failed
    return
  fi
  if ! parsed="$(
    RELEASE_PROBE_LOGS="${probe_logs}" \
    RELEASE_PROBE_EXECUTION_STATUS="${execution_status}" \
    python3 - <<'PY'
import json
import os

check_codes = {
    "bot_health": {
        "none", "timeout", "http_mismatch", "malformed_json", "network_failed",
        "contract_mismatch",
    },
    "bot_readiness": {
        "none", "timeout", "http_mismatch", "malformed_json", "network_failed",
        "contract_mismatch",
    },
    "searxng_root": {"none", "timeout", "http_mismatch", "network_failed"},
    "gateway_empty_webhook": {
        "none", "timeout", "http_mismatch", "malformed_json", "network_failed",
        "contract_mismatch",
    },
    "clamav_signature": {"none", "clamav_manifest_invalid", "signature_warning"},
}

def candidates(value):
    if isinstance(value, dict):
        if set(value) == {"status", "checks"}:
            yield value
        for key in ("Log", "log", "message"):
            nested = value.get(key)
            if isinstance(nested, str):
                try:
                    decoded = json.loads(nested)
                except (TypeError, ValueError):
                    continue
                yield from candidates(decoded)
        for nested in value.values():
            if isinstance(nested, (dict, list)):
                yield from candidates(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from candidates(nested)

raw = os.environ["RELEASE_PROBE_LOGS"]
decoded_values = []
try:
    decoded_values.append(json.loads(raw))
except (TypeError, ValueError):
    for line in raw.splitlines():
        try:
            decoded_values.append(json.loads(line))
        except (TypeError, ValueError):
            pass
payloads = [item for decoded in decoded_values for item in candidates(decoded)]
if len(payloads) != 1:
    raise SystemExit(1)
payload = payloads[0]
if payload["status"] not in {"passed", "failed"} or not isinstance(payload["checks"], list):
    raise SystemExit(1)
observed = []
names = set()
for row in payload["checks"]:
    if not isinstance(row, dict):
        raise SystemExit(1)
    allowed_fields = {"name", "status", "code"}
    if row.get("name") == "clamav_signature":
        allowed_fields.add("signatureHealth")
    if not {"name", "status", "code"} <= set(row) or not set(row) <= allowed_fields:
        raise SystemExit(1)
    name, status, code = row["name"], row["status"], row["code"]
    if name not in check_codes or name in names:
        raise SystemExit(1)
    if status not in {"passed", "failed", "warning"} or code not in check_codes[name]:
        raise SystemExit(1)
    if (status == "warning") != (code == "signature_warning"):
        raise SystemExit(1)
    if status == "passed" and code != "none":
        raise SystemExit(1)
    if status == "failed" and code in {"none", "signature_warning"}:
        raise SystemExit(1)
    if "signatureHealth" in row and row["signatureHealth"] not in {"current", "warning"}:
        raise SystemExit(1)
    names.add(name)
    observed.append((name, status, "http_mismatch" if code == "contract_mismatch" else code))
if names != set(check_codes):
    raise SystemExit(1)
has_failure = any(status == "failed" for _, status, _ in observed)
if (payload["status"] == "failed") != has_failure:
    raise SystemExit(1)
execution_succeeded = os.environ["RELEASE_PROBE_EXECUTION_STATUS"] == "Succeeded"
if execution_succeeded != (payload["status"] == "passed"):
    print("RESULT|status_mismatch|release_probe_status_mismatch")
    raise SystemExit(0)
first_failure = next((name for name, status, _ in observed if status == "failed"), "")
print(f"RESULT|{payload['status']}|{first_failure}")
for name, status, code in observed:
    print(f"{name}|{status}|{code}")
PY
  )"; then
    fail_release_check release_probe release_probe_result_malformed malformed_json
    return
  fi
  while IFS='|' read -r name status code; do
    if [[ "${name}" == "RESULT" ]]; then
      payload_status="${status}"
      failure_reason="${code}"
    elif [[ -n "${name}" ]]; then
      record_release_check "${name}" "${status}" "${code}"
    fi
  done <<<"${parsed}"
  if [[ "${payload_status}" == "status_mismatch" ]]; then
    fail_release_check release_probe "${failure_reason}" http_mismatch
    return
  fi
  if [[ "${payload_status}" == "failed" ]]; then
    fail_release_check release_probe "${failure_reason}_failed" http_mismatch
    return
  fi
  if [[ "${payload_status}" != "passed" ]]; then
    fail_release_check release_probe release_probe_result_malformed malformed_json
    return
  fi
  record_release_check release_probe passed none
}

restore_known_good_revision() {
  local rollback_revision
  local rollback_ok=true
  local rollback_verified=false
  local attempt
  local state_json
  local image

  if ! rollback_revision="$(
    az containerapp revision copy \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${CONTAINER_APP_NAME}" \
      --from-revision "${RELEASE_KNOWN_GOOD_REVISION}" \
      --image "${RELEASE_KNOWN_GOOD_IMAGE}" \
      --query "name" \
      --output tsv \
      --only-show-errors
  )" || [[ -z "${rollback_revision}" ]]; then
    rollback_ok=false
  else
    for ((attempt = 1; attempt <= RELEASE_POLL_ATTEMPTS; attempt += 1)); do
      if state_json="$(
        az containerapp show \
          --resource-group "${RESOURCE_GROUP}" \
          --name "${CONTAINER_APP_NAME}" \
          --query "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,transport:properties.configuration.ingress.transport,dapr:properties.configuration.dapr}" \
          --output json \
          --only-show-errors
      )" && image="$(
        az containerapp revision show \
          --resource-group "${RESOURCE_GROUP}" \
          --name "${CONTAINER_APP_NAME}" \
          --revision "${rollback_revision}" \
          --query "properties.template.containers[0].image" \
          --output tsv \
          --only-show-errors
      )" \
        && RELEASE_ROLLBACK_REVISION="${rollback_revision}" \
        && RELEASE_ROLLBACK_IMAGE="${image}" \
        && RELEASE_ROLLBACK_STATE="${state_json}" \
        RELEASE_ROLLBACK_REVISION_CANDIDATE="${rollback_revision}" \
        RELEASE_ROLLBACK_IMAGE_CANDIDATE="${image}" \
        RELEASE_EXPECTED_ROLLBACK_IMAGE="${RELEASE_KNOWN_GOOD_IMAGE}" \
        python3 - <<'PY'
import json
import os

state = json.loads(os.environ["RELEASE_ROLLBACK_STATE"])
revision = os.environ["RELEASE_ROLLBACK_REVISION_CANDIDATE"]
valid = (
    state.get("latestRevision") == revision
    and state.get("latestReadyRevision") == revision
    and state.get("runningStatus") == "Running"
    and state.get("traffic") == [{"revisionName": revision, "weight": 100}]
    and state.get("external") is False
    and state.get("targetPort") == 3000
    and str(state.get("transport") or "").lower() == "auto"
    and state.get("dapr") == {
        "enabled": True,
        "appId": "hhc-line-function-bot",
        "appPort": 3000,
        "appProtocol": "http",
    }
    and os.environ["RELEASE_ROLLBACK_IMAGE_CANDIDATE"]
    == os.environ["RELEASE_EXPECTED_ROLLBACK_IMAGE"]
)
raise SystemExit(0 if valid else 1)
PY
      then
        RELEASE_ROLLBACK_REVISION="${rollback_revision}"
        RELEASE_ROLLBACK_IMAGE="${image}"
        rollback_verified=true
        break
      fi
      if ((attempt < RELEASE_POLL_ATTEMPTS)); then
        sleep "${RELEASE_POLL_INTERVAL_SECONDS}"
      fi
    done
    if [[ "${rollback_verified}" != "true" ]]; then
      rollback_ok=false
    fi
  fi

  if [[ "${RELEASE_SEARXNG_MUTATED}" == "true" ]]; then
    restore_known_good_searxng || rollback_ok=false
  fi
  if [[ "${RELEASE_CATALOG_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job \
      "${CATALOG_SYNC_JOB_NAME}" \
      "${RELEASE_KNOWN_GOOD_CATALOG_EXISTS}" \
      "${RELEASE_KNOWN_GOOD_CATALOG_IMAGE}" \
      "${RELEASE_KNOWN_GOOD_CATALOG_MANIFEST}" \
      || rollback_ok=false
  fi
  if [[ "${RELEASE_SCAN_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job \
      "${ATTACHMENT_SCAN_JOB_NAME}" \
      "${RELEASE_KNOWN_GOOD_SCAN_EXISTS}" \
      "${RELEASE_KNOWN_GOOD_SCAN_IMAGE}" \
      "${RELEASE_KNOWN_GOOD_SCAN_MANIFEST}" \
      || rollback_ok=false
  fi
  if [[ "${RELEASE_REFRESH_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job \
      "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" \
      "${RELEASE_KNOWN_GOOD_REFRESH_EXISTS}" \
      "${RELEASE_KNOWN_GOOD_REFRESH_IMAGE}" \
      "${RELEASE_KNOWN_GOOD_REFRESH_MANIFEST}" \
      || rollback_ok=false
  fi
  if [[ "${RELEASE_PROBE_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job \
      "${RELEASE_PROBE_JOB_NAME}" \
      "${RELEASE_KNOWN_GOOD_PROBE_EXISTS}" \
      "${RELEASE_KNOWN_GOOD_PROBE_IMAGE}" \
      "${RELEASE_KNOWN_GOOD_PROBE_MANIFEST}" \
      || rollback_ok=false
  fi
  if [[ "${RELEASE_PERIODIC_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job \
      "${PERIODIC_ASSURANCE_JOB_NAME}" \
      "${RELEASE_KNOWN_GOOD_PERIODIC_EXISTS}" \
      "${RELEASE_KNOWN_GOOD_PERIODIC_IMAGE}" \
      "${RELEASE_KNOWN_GOOD_PERIODIC_MANIFEST}" \
      || rollback_ok=false
  fi

  if [[ "${rollback_ok}" == "true" ]]; then
    RELEASE_ROLLBACK_STATUS=restored
    return 0
  fi
  RELEASE_ROLLBACK_STATUS=failed
  return 1
}

restore_known_good_searxng() {
  local rollback_revision
  local state_json
  local image
  if [[ "${RELEASE_KNOWN_GOOD_SEARXNG_EXISTS}" == "false" ]]; then
    az containerapp delete \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${SEARXNG_CONTAINER_APP_NAME}" \
      --yes \
      --only-show-errors \
      --output none || return
    if [[ "$(release_containerapp_exists "${SEARXNG_CONTAINER_APP_NAME}")" != "false" ]]; then
      return 1
    fi
    return 0
  fi
  if ! rollback_revision="$(
    az containerapp revision copy \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${SEARXNG_CONTAINER_APP_NAME}" \
      --from-revision "${RELEASE_KNOWN_GOOD_SEARXNG_REVISION}" \
      --image "${RELEASE_KNOWN_GOOD_SEARXNG_IMAGE}" \
      --query name \
      --output tsv \
      --only-show-errors
  )" || [[ -z "${rollback_revision}" ]]; then
    return 1
  fi
  for ((attempt = 1; attempt <= RELEASE_POLL_ATTEMPTS; attempt += 1)); do
    if state_json="$(
      az containerapp show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${SEARXNG_CONTAINER_APP_NAME}" \
        --query "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,transport:properties.configuration.ingress.transport,minReplicas:properties.template.scale.minReplicas,maxReplicas:properties.template.scale.maxReplicas,cpu:properties.template.containers[0].resources.cpu,memory:properties.template.containers[0].resources.memory}" \
        --output json \
        --only-show-errors
    )" && image="$(
      az containerapp revision show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${SEARXNG_CONTAINER_APP_NAME}" \
        --revision "${rollback_revision}" \
        --query properties.template.containers[0].image \
        --output tsv \
        --only-show-errors
    )" && RELEASE_SEARXNG_ROLLBACK_STATE="${state_json}" \
      RELEASE_SEARXNG_ROLLBACK_REVISION="${rollback_revision}" \
      RELEASE_SEARXNG_ROLLBACK_IMAGE="${image}" \
      RELEASE_SEARXNG_EXPECTED_IMAGE="${RELEASE_KNOWN_GOOD_SEARXNG_IMAGE}" \
      python3 - <<'PY'
import json
import os

state = json.loads(os.environ["RELEASE_SEARXNG_ROLLBACK_STATE"])
revision = os.environ["RELEASE_SEARXNG_ROLLBACK_REVISION"]
valid = (
    state.get("latestRevision") == revision
    and state.get("latestReadyRevision") == revision
    and state.get("runningStatus") == "Running"
    and state.get("traffic") == [{"revisionName": revision, "weight": 100}]
    and state.get("external") is False
    and state.get("targetPort") == 8080
    and str(state.get("transport") or "").lower() == "http"
    and state.get("minReplicas") == 1
    and state.get("maxReplicas") == 1
    and state.get("cpu") == 0.25
    and state.get("memory") == "0.5Gi"
    and os.environ["RELEASE_SEARXNG_ROLLBACK_IMAGE"]
    == os.environ["RELEASE_SEARXNG_EXPECTED_IMAGE"]
)
raise SystemExit(0 if valid else 1)
PY
    then
      return 0
    fi
    if ((attempt < RELEASE_POLL_ATTEMPTS)); then
      sleep "${RELEASE_POLL_INTERVAL_SECONDS}"
    fi
  done
  return 1
}

restore_changed_job() {
  local job_name="$1"
  local existed="$2"
  local known_image="$3"
  local known_manifest="$4"
  local observed_image
  local observed_json
  local observed_manifest
  if [[ "${existed}" == "false" ]]; then
    az containerapp job delete \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${job_name}" \
      --yes \
      --only-show-errors \
      --output none || return
    if [[ "$(release_job_exists "${job_name}")" != "false" ]]; then
      return 1
    fi
    return 0
  fi
  az containerapp job update \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${job_name}" \
    --yaml "${known_manifest}" \
    --only-show-errors \
    --output none || return
  observed_image="$(release_job_image "${job_name}")" || return
  observed_image="$(resolve_release_image "${observed_image}")" || return
  [[ "${observed_image}" == "${known_image}" ]] || return
  observed_json="$(release_job_manifest_json "${job_name}")" || return
  observed_manifest="$(mktemp)"
  RELEASE_CLEANUP_FILES+=("${observed_manifest}")
  normalize_release_job_manifest "${observed_json}" "${observed_image}" "${observed_manifest}" || return
  cmp -s -- "${known_manifest}" "${observed_manifest}"
}

write_release_report() {
  RELEASE_REPORT_PATH="${RELEASE_REPORT_PATH:-artifacts/release-assurance/report.json}"
  local known_good_revision="${RELEASE_KNOWN_GOOD_REVISION:-unavailable}"
  local known_good_image="${RELEASE_KNOWN_GOOD_IMAGE:-unavailable}"
  local target_revision="${RELEASE_TARGET_REVISION:-${known_good_revision}}"
  local target_image="${RELEASE_TARGET_IMAGE:-${known_good_image}}"
  local status=failed
  local target_status=failed
  if [[ "${RELEASE_FAILURE_REASON}" == "none" ]]; then
    status=passed
    target_status=ready
  fi

  if RELEASE_REPORT_STATUS="${status}" \
  RELEASE_REPORT_TARGET_STATUS="${target_status}" \
  RELEASE_REPORT_TARGET_REVISION="${target_revision}" \
  RELEASE_REPORT_TARGET_IMAGE="${target_image}" \
  RELEASE_REPORT_COMMIT_SHA="${RELEASE_COMMIT_SHA:-${GITHUB_SHA:-0000000000000000000000000000000000000000}}" \
  RELEASE_REPORT_ID="${RELEASE_ID:-${GITHUB_RUN_ID:-unavailable}}" \
  RELEASE_FAILURE_REASON="${RELEASE_FAILURE_REASON}" \
  RELEASE_CHECK_RECORDS="${RELEASE_CHECK_RECORDS}" \
  RELEASE_STARTED_AT="${RELEASE_STARTED_AT}" \
  RELEASE_ROLLBACK_STATUS="${RELEASE_ROLLBACK_STATUS}" \
  RELEASE_ROLLBACK_REVISION="${RELEASE_ROLLBACK_REVISION}" \
  RELEASE_ROLLBACK_IMAGE="${RELEASE_ROLLBACK_IMAGE}" \
  RELEASE_KNOWN_GOOD_REVISION="${known_good_revision}" \
  RELEASE_KNOWN_GOOD_IMAGE="${known_good_image}" \
  RELEASE_PROVIDER_CONTRACT_VERIFIED="${RELEASE_PROVIDER_CONTRACT_VERIFIED}" \
  python3 - <<'PY'
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile

failure_map = {
    "none": "none",
    "preflight_failed": "network_failed",
    "known_good_snapshot_failed": "network_failed",
    "target_state_unavailable": "network_failed",
    "target_revision_mismatch": "timeout",
    "target_image_mismatch": "http_mismatch",
    "target_traffic_mismatch": "http_mismatch",
    "bot_ingress_mismatch": "http_mismatch",
    "bot_dapr_mismatch": "http_mismatch",
    "malformed_target_state": "malformed_json",
    "searxng_definition_mismatch": "http_mismatch",
    "refresh_definition_mismatch": "http_mismatch",
    "scan_definition_mismatch": "http_mismatch",
    "catalog_definition_mismatch": "http_mismatch",
    "catalog_recent_success_missing": "timeout",
    "release_probe_definition_mismatch": "http_mismatch",
    "periodic_definition_mismatch": "http_mismatch",
    "clamav_bootstrap_failed": "clamav_manifest_invalid",
    "clamav_bootstrap_failed_timeout": "timeout",
    "clamav_bootstrap_start_failed": "network_failed",
    "release_probe_start_failed": "network_failed",
    "release_probe_failed": "http_mismatch",
    "release_probe_failed_timeout": "timeout",
    "release_probe_logs_failed": "network_failed",
    "release_probe_result_malformed": "malformed_json",
    "release_probe_status_mismatch": "http_mismatch",
    "bot_health_failed": "bot_health_failed",
    "bot_readiness_failed": "bot_readiness_failed",
    "searxng_root_failed": "searxng_root_failed",
    "gateway_empty_webhook_failed": "gateway_webhook_failed",
    "clamav_signature_failed": "clamav_manifest_invalid",
    "report_write_failed": "network_failed",
    "transaction_incomplete": "network_failed",
    "unclassified_release_failure": "network_failed",
    "unexpected_release_job": "http_mismatch",
}
check_names = {
    "target_revision",
    "target_traffic",
    "bot_ingress",
    "bot_dapr",
    "searxng_deployment",
    "release_probe",
    "catalog_job",
    "clamav_refresh_job",
    "attachment_scan_job",
    "periodic_assurance_job",
    "bot_health",
    "bot_readiness",
    "searxng_root",
    "gateway_empty_webhook",
    "clamav_signature",
}
check_codes = {
    "none",
    "network_failed",
    "timeout",
    "http_mismatch",
    "malformed_json",
    "clamav_manifest_invalid",
    "signature_warning",
}

def image_identity(value):
    marker = "@sha256:"
    if marker in value:
        digest = value.rsplit(marker, 1)[1]
        if len(digest) == 64 and all(char in "0123456789abcdef" for char in digest):
            return "sha256:" + digest
    return "sha256:" + sha256(value.encode("utf-8")).hexdigest()

checks = []
for row in os.environ.get("RELEASE_CHECK_RECORDS", "").splitlines():
    name, status, observed_at, code = row.split("|")
    if name not in check_names or status not in {"passed", "failed", "warning"} or code not in check_codes:
        raise SystemExit("invalid release check")
    if (status == "warning") != (code == "signature_warning"):
        raise SystemExit("invalid release warning")
    if status == "passed" and code != "none":
        raise SystemExit("invalid passed release check")
    if status == "failed" and code == "none":
        raise SystemExit("invalid failed release check")
    checks.append(
        {"name": name, "status": status, "observedAt": observed_at, "code": code}
    )

reason = os.environ["RELEASE_FAILURE_REASON"]
if reason not in failure_map:
    raise SystemExit("unknown release failure reason")
failure_code = failure_map[reason]
rollback_status = os.environ["RELEASE_ROLLBACK_STATUS"]
rollback = {"status": rollback_status}
rollback_revision = os.environ["RELEASE_ROLLBACK_REVISION"]
rollback_image = os.environ["RELEASE_ROLLBACK_IMAGE"]
if bool(rollback_revision) != bool(rollback_image):
    raise SystemExit("incomplete rollback observation")
if rollback_status == "restored" and not rollback_revision:
    raise SystemExit("restored rollback observation missing")
if rollback_revision:
    rollback.update(
        {
            "revision": rollback_revision,
            "image": image_identity(rollback_image),
        }
    )
report = {
    "version": 1,
    "kind": "release",
    "releaseId": os.environ["RELEASE_REPORT_ID"],
    "commitSha": os.environ["RELEASE_REPORT_COMMIT_SHA"],
    "startedAt": os.environ["RELEASE_STARTED_AT"],
    "completedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    ),
    "status": os.environ["RELEASE_REPORT_STATUS"],
    "failureCode": failure_code,
    "target": {
        "resource": "bot",
        "revision": os.environ["RELEASE_REPORT_TARGET_REVISION"],
        "image": image_identity(os.environ["RELEASE_REPORT_TARGET_IMAGE"]),
        "status": os.environ["RELEASE_REPORT_TARGET_STATUS"],
    },
    "knownGood": {
        "revision": os.environ["RELEASE_KNOWN_GOOD_REVISION"],
        "image": image_identity(os.environ["RELEASE_KNOWN_GOOD_IMAGE"]),
    },
    "checks": checks,
    "rollback": rollback,
}
if os.environ["RELEASE_PROVIDER_CONTRACT_VERIFIED"] == "true":
    report["providerRequests"] = {"deepseek": 0, "embedding": 0}
elif report["status"] == "passed":
    raise SystemExit("passed release lacks provider contract verification")

path = Path(os.environ["RELEASE_REPORT_PATH"])
path.parent.mkdir(parents=True, exist_ok=True)
descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(report, stream, separators=(",", ":"), sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
  then
    RELEASE_REPORT_WRITTEN=true
    return 0
  fi
  RELEASE_REPORT_WRITTEN=false
  return 1
}

release_assurance_on_exit() {
  local original_status="$1"
  trap - EXIT
  set +e

  if ((original_status == 0)) \
    && [[ "${RELEASE_TRANSACTION_COMPLETE}" != "true" ]]; then
    original_status=1
    set_release_failure transaction_incomplete
  fi
  if ((original_status != 0)) \
    && [[ "${RELEASE_FAILURE_REASON}" == "none" ]]; then
    set_release_failure unclassified_release_failure
  fi
  if ((original_status != 0)) \
    && [[ "${RELEASE_MUTATED}" == "true" ]] \
    && [[ "${RELEASE_TRANSACTION_COMPLETE}" != "true" ]]; then
    restore_known_good_revision
  fi
  if [[ "${RELEASE_REPORT_WRITTEN}" != "true" ]]; then
    write_release_report
  fi
  if ((${#RELEASE_CLEANUP_FILES[@]} > 0)); then
    rm -f -- "${RELEASE_CLEANUP_FILES[@]}"
  fi
  exit "${original_status}"
}
