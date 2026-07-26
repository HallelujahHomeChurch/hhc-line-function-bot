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
  if ! RELEASE_KNOWN_GOOD_IMAGE="$(
    az containerapp revision show \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${CONTAINER_APP_NAME}" \
      --revision "${RELEASE_KNOWN_GOOD_REVISION}" \
      --query "properties.template.containers[0].image" \
      --output tsv \
      --only-show-errors
  )" || [[ -z "${RELEASE_KNOWN_GOOD_IMAGE}" ]]; then
    set_release_failure known_good_snapshot_failed
    return 1
  fi

  if ! RELEASE_KNOWN_GOOD_CATALOG_IMAGE="$(release_job_image "${CATALOG_SYNC_JOB_NAME}")" \
    || [[ -z "${RELEASE_KNOWN_GOOD_CATALOG_IMAGE}" ]] \
    || ! RELEASE_KNOWN_GOOD_SCAN_IMAGE="$(release_job_image "${ATTACHMENT_SCAN_JOB_NAME}")" \
    || [[ -z "${RELEASE_KNOWN_GOOD_SCAN_IMAGE}" ]] \
    || ! RELEASE_KNOWN_GOOD_REFRESH_IMAGE="$(release_job_image "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}")" \
    || [[ -z "${RELEASE_KNOWN_GOOD_REFRESH_IMAGE}" ]]; then
    set_release_failure known_good_snapshot_failed
    return 1
  fi
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

mark_release_mutated() {
  RELEASE_MUTATED=true
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
        or state.get("transport") != "auto"
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
    and state.get("transport") == "http"
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
    valid = valid and trigger.get("cronExpression") == "*/15 * * * *"
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
  release_wait_for_job_execution \
    "${RELEASE_PROBE_JOB_NAME}" "${execution_name}" \
    release_probe release_probe_failed http_mismatch || return
  record_release_check bot_health passed none
  record_release_check bot_readiness passed none
  record_release_check searxng_root passed none
  record_release_check gateway_empty_webhook passed none
  record_release_check clamav_signature passed none
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

  if [[ "${RELEASE_CATALOG_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job_image "${CATALOG_SYNC_JOB_NAME}" "${RELEASE_KNOWN_GOOD_CATALOG_IMAGE}" \
      || rollback_ok=false
  fi
  if [[ "${RELEASE_SCAN_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job_image "${ATTACHMENT_SCAN_JOB_NAME}" "${RELEASE_KNOWN_GOOD_SCAN_IMAGE}" \
      || rollback_ok=false
  fi
  if [[ "${RELEASE_REFRESH_JOB_MUTATED}" == "true" ]]; then
    restore_changed_job_image "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}" "${RELEASE_KNOWN_GOOD_REFRESH_IMAGE}" \
      || rollback_ok=false
  fi

  if [[ "${rollback_ok}" == "true" ]]; then
    RELEASE_ROLLBACK_STATUS=restored
    return 0
  fi
  RELEASE_ROLLBACK_STATUS=failed
  return 1
}

restore_changed_job_image() {
  local job_name="$1"
  local known_image="$2"
  local current_image
  local restored_image
  if ! current_image="$(release_job_image "${job_name}")"; then
    return 1
  fi
  if [[ "${current_image}" == "${known_image}" ]]; then
    return 0
  fi
  az containerapp job update \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${job_name}" \
    --image "${known_image}" \
    --only-show-errors \
    --output none || return
  restored_image="$(release_job_image "${job_name}")" || return
  [[ "${restored_image}" == "${known_image}" ]]
}

write_release_report() {
  : "${RELEASE_REPORT_PATH:?RELEASE_REPORT_PATH is required}"
  : "${RELEASE_KNOWN_GOOD_REVISION:?known-good revision is required}"
  : "${RELEASE_KNOWN_GOOD_IMAGE:?known-good image is required}"
  local target_revision="${RELEASE_TARGET_REVISION:-${RELEASE_KNOWN_GOOD_REVISION}}"
  local target_image="${RELEASE_TARGET_IMAGE:-${RELEASE_KNOWN_GOOD_IMAGE}}"
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
  RELEASE_REPORT_COMMIT_SHA="${RELEASE_COMMIT_SHA:-${GITHUB_SHA:-}}" \
  RELEASE_REPORT_ID="${RELEASE_ID:-${GITHUB_RUN_ID:-}}" \
  RELEASE_FAILURE_REASON="${RELEASE_FAILURE_REASON}" \
  RELEASE_CHECK_RECORDS="${RELEASE_CHECK_RECORDS}" \
  RELEASE_STARTED_AT="${RELEASE_STARTED_AT}" \
  RELEASE_ROLLBACK_STATUS="${RELEASE_ROLLBACK_STATUS}" \
  RELEASE_ROLLBACK_REVISION="${RELEASE_ROLLBACK_REVISION}" \
  RELEASE_ROLLBACK_IMAGE="${RELEASE_ROLLBACK_IMAGE}" \
  RELEASE_KNOWN_GOOD_REVISION="${RELEASE_KNOWN_GOOD_REVISION}" \
  RELEASE_KNOWN_GOOD_IMAGE="${RELEASE_KNOWN_GOOD_IMAGE}" \
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
    "release_probe_start_failed": "network_failed",
    "release_probe_failed": "http_mismatch",
    "release_probe_failed_timeout": "timeout",
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
    if name not in check_names or status not in {"passed", "failed"} or code not in check_codes:
        raise SystemExit("invalid release check")
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
