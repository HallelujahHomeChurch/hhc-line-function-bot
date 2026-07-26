#!/usr/bin/env bash
set -Eeuo pipefail

: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${PERIODIC_ASSURANCE_JOB_NAME:?PERIODIC_ASSURANCE_JOB_NAME is required}"
: "${ATTACHMENT_SCAN_JOB_NAME:?ATTACHMENT_SCAN_JOB_NAME is required}"
: "${PERIODIC_REPORT_PATH:?PERIODIC_REPORT_PATH is required}"
: "${PERIODIC_RUN_ID:?PERIODIC_RUN_ID is required}"
: "${PERIODIC_COMMIT_SHA:?PERIODIC_COMMIT_SHA is required}"

PERIODIC_POLL_ATTEMPTS="${PERIODIC_POLL_ATTEMPTS:-120}"
PERIODIC_POLL_INTERVAL_SECONDS="${PERIODIC_POLL_INTERVAL_SECONDS:-5}"
PERIODIC_RECENT_SCAN_MAX_AGE_SECONDS="${PERIODIC_RECENT_SCAN_MAX_AGE_SECONDS:-604800}"

for numeric_value in \
  "${PERIODIC_POLL_ATTEMPTS}" \
  "${PERIODIC_POLL_INTERVAL_SECONDS}" \
  "${PERIODIC_RECENT_SCAN_MAX_AGE_SECONDS}"; do
  if [[ ! "${numeric_value}" =~ ^[0-9]+$ ]] || ((numeric_value < 1)); then
    exit 2
  fi
done

started_at="$(date -u +%Y-%m-%dT%H:%M:%S.%N)"
started_at="${started_at:0:23}Z"
runner_failure=none
execution_name=""
execution_status=""
periodic_logs=""
scan_execution="null"

if ! periodic_image="$(
  az containerapp job show \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${PERIODIC_ASSURANCE_JOB_NAME}" \
    --query "properties.template.containers[0].image" \
    --output tsv \
    --only-show-errors 2>/dev/null
)" || [[ -z "${periodic_image}" ]]; then
  periodic_image="periodic-assurance-unavailable"
  runner_failure=network_failed
fi

if [[ "${runner_failure}" == "none" ]]; then
  if ! execution_name="$(
    az containerapp job start \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${PERIODIC_ASSURANCE_JOB_NAME}" \
      --query "name" \
      --output tsv \
      --only-show-errors 2>/dev/null
  )" || [[ -z "${execution_name}" ]]; then
    runner_failure=network_failed
  fi
fi

if [[ "${runner_failure}" == "none" ]]; then
  for ((attempt = 1; attempt <= PERIODIC_POLL_ATTEMPTS; attempt += 1)); do
    if ! execution_status="$(
      az containerapp job execution show \
        --resource-group "${RESOURCE_GROUP}" \
        --name "${PERIODIC_ASSURANCE_JOB_NAME}" \
        --job-execution-name "${execution_name}" \
        --query "properties.status" \
        --output tsv \
        --only-show-errors 2>/dev/null
    )"; then
      runner_failure=network_failed
      break
    fi
    case "${execution_status}" in
      Succeeded | Failed | Stopped)
        break
        ;;
      *)
        if ((attempt == PERIODIC_POLL_ATTEMPTS)); then
          runner_failure=timeout
        else
          sleep "${PERIODIC_POLL_INTERVAL_SECONDS}"
        fi
        ;;
    esac
  done
fi

if [[ "${execution_status}" == "Succeeded" || "${execution_status}" == "Failed" || "${execution_status}" == "Stopped" ]]; then
  if ! periodic_logs="$(
    az containerapp job logs show \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${PERIODIC_ASSURANCE_JOB_NAME}" \
      --execution "${execution_name}" \
      --container periodic-assurance \
      --tail 20 \
      --format json \
      --only-show-errors 2>/dev/null
  )"; then
    runner_failure=network_failed
  fi
fi

if ! scan_execution="$(
  az containerapp job execution list \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${ATTACHMENT_SCAN_JOB_NAME}" \
    --query "sort_by(@, &properties.startTime)[-1].{name:name,status:properties.status,startTime:properties.startTime}" \
    --output json \
    --only-show-errors 2>/dev/null
)"; then
  scan_execution="null"
  if [[ "${runner_failure}" == "none" ]]; then
    runner_failure=network_failed
  fi
fi

PERIODIC_STARTED_AT="${started_at}" \
PERIODIC_RUNNER_FAILURE="${runner_failure}" \
PERIODIC_EXECUTION_NAME="${execution_name}" \
PERIODIC_EXECUTION_STATUS="${execution_status}" \
PERIODIC_IMAGE="${periodic_image}" \
PERIODIC_LOGS="${periodic_logs}" \
PERIODIC_SCAN_EXECUTION="${scan_execution}" \
PERIODIC_RECENT_SCAN_MAX_AGE_SECONDS="${PERIODIC_RECENT_SCAN_MAX_AGE_SECONDS}" \
python3 - <<'PY'
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile

check_codes = {
    "graph_metadata": {"none", "graph_metadata_failed"},
    "notion_query": {"none", "notion_query_failed"},
    "attachment_queue": {"none", "attachment_queue_failed"},
    "clamav_signature": {"none", "clamav_manifest_invalid", "signature_warning"},
    "clamav_clean": {"none", "clamav_manifest_invalid", "clamav_clean_failed"},
    "clamav_eicar": {"none", "clamav_manifest_invalid", "clamav_eicar_failed"},
    "diagnostic_write_delete": {
        "none",
        "diagnostic_folder_failed",
        "diagnostic_upload_failed",
        "diagnostic_delete_failed",
    },
}
expected_checks = set(check_codes)
runner_codes = {"none", "network_failed", "timeout", "http_mismatch", "malformed_json"}


def iso_now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def image_identity(value):
    marker = "@sha256:"
    if marker in value:
        digest = value.rsplit(marker, 1)[1]
        if len(digest) == 64 and all(character in "0123456789abcdef" for character in digest):
            return "sha256:" + digest
    return "sha256:" + sha256(value.encode("utf-8")).hexdigest()


def payload_candidates(value):
    if isinstance(value, dict):
        if {"status", "checks", "providerRequests"} <= set(value):
            yield value
        for key in ("Log", "log", "message"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                try:
                    decoded = json.loads(candidate)
                except (TypeError, ValueError):
                    continue
                yield from payload_candidates(decoded)
        for nested in value.values():
            if isinstance(nested, (dict, list)):
                yield from payload_candidates(nested)
    elif isinstance(value, list):
        for item in value:
            yield from payload_candidates(item)


def read_payload(raw):
    if not raw:
        return None
    decoded_values = []
    try:
        decoded_values.append(json.loads(raw))
    except (TypeError, ValueError):
        for line in raw.splitlines():
            try:
                decoded_values.append(json.loads(line))
            except (TypeError, ValueError):
                continue
    candidates = [
        candidate
        for decoded in decoded_values
        for candidate in payload_candidates(decoded)
    ]
    return candidates[-1] if candidates else None


def validate_payload(value):
    if not isinstance(value, dict) or set(value) != {
        "status",
        "checks",
        "queue",
        "providerRequests",
    }:
        raise ValueError("invalid periodic result")
    status = value["status"]
    if status not in {"passed", "failed"}:
        raise ValueError("invalid periodic status")
    if value["providerRequests"] != {"deepseek": 0, "embedding": 0}:
        raise ValueError("invalid periodic provider result")
    if not isinstance(value["checks"], list):
        raise ValueError("invalid periodic checks")
    checks = []
    names = set()
    for row in value["checks"]:
        if not isinstance(row, dict) or set(row) != {"name", "status", "code"}:
            raise ValueError("invalid periodic check")
        name = row["name"]
        check_status = row["status"]
        code = row["code"]
        if name not in check_codes or name in names:
            raise ValueError("invalid periodic check name")
        if check_status not in {"passed", "failed", "warning"} or code not in check_codes[name]:
            raise ValueError("invalid periodic check result")
        if (check_status == "warning") != (code == "signature_warning"):
            raise ValueError("invalid periodic warning")
        if check_status == "passed" and code != "none":
            raise ValueError("invalid periodic passed result")
        if check_status == "failed" and code == "none":
            raise ValueError("invalid periodic failed result")
        names.add(name)
        checks.append({"name": name, "status": check_status, "code": code})
    if names != expected_checks:
        raise ValueError("incomplete periodic checks")
    has_failure = any(check["status"] == "failed" for check in checks)
    if (status == "failed") != has_failure:
        raise ValueError("inconsistent periodic result")
    return status, checks


def recent_scan_failed(raw):
    try:
        value = json.loads(raw or "null")
    except (TypeError, ValueError):
        raise ValueError("invalid scan observation")
    if value in (None, {}):
        return False
    if not isinstance(value, dict):
        raise ValueError("invalid scan observation")
    status = value.get("status")
    start_time = value.get("startTime")
    if status not in {"Running", "Processing", "Succeeded", "Failed", "Stopped"}:
        raise ValueError("invalid scan status")
    if not isinstance(start_time, str):
        raise ValueError("invalid scan time")
    try:
        started = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("invalid scan time") from error
    age = (datetime.now(timezone.utc) - started).total_seconds()
    recent = -300 <= age <= int(os.environ["PERIODIC_RECENT_SCAN_MAX_AGE_SECONDS"])
    return recent and status in {"Failed", "Stopped"}


completed_at = iso_now()
runner_failure = os.environ["PERIODIC_RUNNER_FAILURE"]
if runner_failure not in runner_codes:
    runner_failure = "malformed_json"
checks = []
payload_status = None
payload = read_payload(os.environ.get("PERIODIC_LOGS", ""))
if payload is not None:
    try:
        payload_status, checks = validate_payload(payload)
    except ValueError:
        runner_failure = "malformed_json"
elif os.environ["PERIODIC_EXECUTION_STATUS"] in {"Succeeded", "Failed", "Stopped"}:
    runner_failure = "malformed_json"
workload_failure_code = (
    next(check["code"] for check in checks if check["status"] == "failed")
    if payload_status == "failed"
    else None
)

try:
    scan_failed = recent_scan_failed(os.environ["PERIODIC_SCAN_EXECUTION"])
except ValueError:
    scan_failed = False
    if runner_failure == "none":
        runner_failure = "malformed_json"
if scan_failed:
    for check in checks:
        if check["name"] == "attachment_queue" and check["status"] != "failed":
            check.update({"status": "failed", "code": "http_mismatch"})
    if runner_failure == "none" and payload_status != "failed":
        runner_failure = "http_mismatch"

execution_status = os.environ["PERIODIC_EXECUTION_STATUS"]
if (
    runner_failure == "none"
    and payload_status is not None
    and ((execution_status == "Succeeded") != (payload_status == "passed"))
):
    runner_failure = "http_mismatch"

if payload_status == "failed":
    failure_code = workload_failure_code
elif runner_failure != "none":
    failure_code = runner_failure
else:
    failure_code = "none"
status = "passed" if failure_code == "none" else "failed"
observed_checks = [
    {
        "name": check["name"],
        "status": check["status"],
        "observedAt": completed_at,
        "code": check["code"],
    }
    for check in checks
]
execution_name = os.environ["PERIODIC_EXECUTION_NAME"] or "periodic-unavailable"
image = image_identity(os.environ["PERIODIC_IMAGE"])
report = {
    "version": 1,
    "kind": "periodic",
    "releaseId": os.environ["PERIODIC_RUN_ID"],
    "commitSha": os.environ["PERIODIC_COMMIT_SHA"],
    "startedAt": os.environ["PERIODIC_STARTED_AT"],
    "completedAt": completed_at,
    "status": status,
    "failureCode": failure_code,
    "target": {
        "resource": "periodic_assurance",
        "revision": execution_name,
        "image": image,
        "status": "ready" if status == "passed" else "failed",
    },
    "knownGood": {
        "revision": os.environ["PERIODIC_ASSURANCE_JOB_NAME"],
        "image": image,
    },
    "checks": observed_checks,
    "rollback": {"status": "not_required"},
    "providerRequests": {"deepseek": 0, "embedding": 0},
}

path = Path(os.environ["PERIODIC_REPORT_PATH"])
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
raise SystemExit(0 if status == "passed" else 1)
PY
