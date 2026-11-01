#!/usr/bin/env python3
"""Bind deferred public acceptance to the same successful deployment and state fence."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def require(value):
    if not value:
        raise ValueError("release receipt invalid")


def az(*args):
    result = subprocess.run(["az", *args, "--output", "json", "--only-show-errors"], capture_output=True, timeout=45)
    require(result.returncode == 0)
    return json.loads(result.stdout)


def state_fence(revision):
    spec = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("redis-recovery.py"))
    recovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recovery)
    query = "properties.template.containers[0].env[?name=='REDIS_KEY_PREFIX'||name=='LINE_REDIS_RECOVERY'||name=='LINE_REDIS_RECOVERY_CUTOFF_MS'||name=='LINE_RUNTIME_STATE_CONTRACT']"
    group = os.environ["RESOURCE_GROUP"]
    api = az("containerapp", "revision", "show", "-g", group, "-n", os.environ["CONTAINER_APP_NAME"], "--revision", revision, "--query", query)
    require([row.get("value") for row in api if row.get("name") == "LINE_RUNTIME_STATE_CONTRACT"] == ["2"])
    selected = recovery.select(None, json.dumps(api))
    for kind, key in (("app", "ATTACHMENT_WORKER_APP_NAME"), ("job", "ATTACHMENT_SCAN_JOB_NAME"), ("job", "CATALOG_SYNC_JOB_NAME")):
        command = ("containerapp", "show") if kind == "app" else ("containerapp", "job", "show")
        rows = az(*command, "-g", group, "-n", os.environ[key], "--query", query)
        require(recovery.select(None, json.dumps(rows)) == selected)
    digest = hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return digest, selected


def validate(value):
    require(set(value) == {"version", "commit", "runId", "deploymentAttempt", "revision", "image", "attachmentExecution", "startedAt", "publicState", "redisFenceSha256", "knownGoodRevision", "knownGoodImage"})
    require(value["version"] == 2 and value["commit"] == os.environ["GITHUB_SHA"] and re.fullmatch(r"[a-f0-9]{40}", value["commit"]))
    require(value["runId"] == os.environ["GITHUB_RUN_ID"] and value["runId"].isdigit())
    require(type(value["deploymentAttempt"]) is int and 1 <= value["deploymentAttempt"] <= int(os.environ["GITHUB_RUN_ATTEMPT"]))
    for key in ("revision", "attachmentExecution", "knownGoodRevision"):
        require(isinstance(value[key], str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,200}", value[key]))
    for key in ("image", "knownGoodImage"):
        require(isinstance(value[key], str) and re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}", value[key]))
    require(value["publicState"] in {"accepted", "pending"})
    require(isinstance(value["startedAt"], str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value["startedAt"]))
    require(re.fullmatch(r"[a-f0-9]{64}", value["redisFenceSha256"]))
    return value


def main():
    action = sys.argv[1]
    path = Path(os.environ.get("RELEASE_RECEIPT_PATH", "artifacts/release-assurance/deployment.json"))
    if action == "write":
        fence, _ = state_fence(os.environ["RELEASE_TARGET_REVISION"])
        report = json.loads(Path(os.environ["RELEASE_REPORT_PATH"]).read_text())
        require(report["status"] in {"passed", "private_verified_public_pending"} and report["failureCode"] == "none")
        value = validate({"version": 2, "commit": os.environ["GITHUB_SHA"], "runId": os.environ["GITHUB_RUN_ID"], "deploymentAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"]), "revision": os.environ["RELEASE_TARGET_REVISION"], "image": os.environ["RELEASE_TARGET_IMAGE"], "attachmentExecution": os.environ["RELEASE_ATTACHMENT_BOOTSTRAP_EXECUTION_NAME"], "startedAt": os.environ["RELEASE_STARTED_AT"], "publicState": "pending" if report["status"] == "private_verified_public_pending" else "accepted", "redisFenceSha256": fence, "knownGoodRevision": os.environ["RELEASE_KNOWN_GOOD_REVISION"], "knownGoodImage": os.environ["RELEASE_KNOWN_GOOD_IMAGE"]})
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    elif action == "read":
        value = validate(json.loads(path.read_text()))
        require(value["revision"] == os.environ["DEPLOYED_REVISION"] and value["image"] == os.environ["DEPLOYED_IMAGE"])
        require(value["deploymentAttempt"] == int(os.environ["DEPLOYMENT_ATTEMPT"]))
        fence, selected = state_fence(value["revision"])
        require(fence == value["redisFenceSha256"])
        mapping = {"RELEASE_TARGET_REVISION": "revision", "RELEASE_TARGET_IMAGE": "image", "RELEASE_TARGET_SCAN_IMAGE": "image", "RELEASE_TARGET_ATTACHMENT_IMAGE": "image", "RELEASE_TARGET_ATTACHMENT_APP_IMAGE": "image", "RELEASE_ATTACHMENT_BOOTSTRAP_EXECUTION_NAME": "attachmentExecution", "RELEASE_STARTED_AT": "startedAt", "RELEASE_KNOWN_GOOD_REVISION": "knownGoodRevision", "RELEASE_KNOWN_GOOD_IMAGE": "knownGoodImage", "DEPLOYED_PUBLIC_STATE": "publicState"}
        for key, field in mapping.items():
            print(key + "=" + str(value[field]))
        print("RELEASE_RECOVERY_ENV_JSON=" + json.dumps(selected, separators=(",", ":")))
    else:
        raise ValueError("unknown receipt action")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Release deployment receipt verification failed.", file=sys.stderr)
        raise SystemExit(1)
