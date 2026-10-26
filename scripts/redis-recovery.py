#!/usr/bin/env python3
"""Offline recovery review and release configuration selection; never connects to a service."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

DEFAULT_PREFIX = "hhc-line-function-bot"
OWNERS = {"api", "attachment_app", "attachment_job", "catalog_job", "webhook_delivery", "queues"}
SHA = re.compile(r"^[0-9a-f]{64}$")


def require(condition):
    if not condition:
        raise ValueError("redis_recovery_evidence_invalid")


def fence(value):
    require(isinstance(value, dict) and set(value) == {"operationId", "previousPrefix", "prefix", "cutoffMs", "journalSha256"})
    require(isinstance(value["operationId"], str))
    require(str(uuid.UUID(value["operationId"])) == value["operationId"])
    require(value["prefix"] == f'{DEFAULT_PREFIX}:recovery:{value["operationId"]}')
    require(isinstance(value["previousPrefix"], str) and re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", value["previousPrefix"]))
    require(value["previousPrefix"] != value["prefix"])
    require(type(value["cutoffMs"]) is int and 10**12 <= value["cutoffMs"] < 10**13)
    require(isinstance(value["journalSha256"], str) and SHA.fullmatch(value["journalSha256"]))
    return value


def plan(journal):
    require(isinstance(journal, dict) and journal.get("version") == 1)
    require(journal.get("incident") in {"full_loss", "partial_loss", "stale_restore", "oom_retained"})
    if journal["incident"] == "oom_retained":
        raise ValueError("retained_state_must_not_rotate")
    require(journal.get("inventoryComplete") is True)
    owners = journal.get("owners")
    require(isinstance(owners, dict) and set(owners) == OWNERS)
    for evidence in owners.values():
        require(isinstance(evidence, dict) and evidence.get("heldAndDrained") is True)
        require(SHA.fullmatch(evidence.get("evidenceSha256", "")))
    require(journal.get("queuesQuarantinedOrDrained") is True)
    require(SHA.fullmatch(journal.get("queueEvidenceSha256", "")))
    require(journal.get("oldApprovalsRetired") is True)
    require(journal.get("noAutomaticReplay") is True)
    require(type(journal.get("lossFromMs")) is int and 0 < journal["lossFromMs"] <= journal["cutoffMs"])
    effects = journal.get("effects")
    require(isinstance(effects, list))
    seen = set()
    counts = {"completed": 0, "not_started": 0, "unknown": 0}
    for effect in effects:
        require(isinstance(effect, dict) and SHA.fullmatch(effect.get("correlationSha256", "")))
        require(effect["correlationSha256"] not in seen)
        seen.add(effect["correlationSha256"])
        status = effect.get("status")
        require(status in counts)
        # Missing receipts/absence of logs are not evidence that an effect never began.
        if status == "unknown":
            require(effect.get("disposition") == "quarantined")
            require(effect.get("evidenceKind") == "quarantine_record")
        else:
            require(effect.get("disposition") == "no_replay")
            require(effect.get("evidenceKind") in ({"durable_owner_commit", "provider_commit"} if status == "completed" else {"durable_pre_dispatch_record"}))
        require(SHA.fullmatch(effect.get("evidenceSha256", "")))
        counts[status] += 1
    candidate = fence({key: journal[key] for key in ("operationId", "previousPrefix", "prefix", "cutoffMs")} | {
        "journalSha256": hashlib.sha256(json.dumps(journal, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    })
    require(isinstance(journal.get("retiredPrefixes"), list))
    require(candidate["previousPrefix"] in journal["retiredPrefixes"] and candidate["prefix"] not in journal["retiredPrefixes"])
    return {"candidate": candidate, "counts": counts, "evidence": "operator_attestations_not_machine_proof"}


def environment(raw):
    entries = json.loads(raw)
    require(isinstance(entries, list))
    values = {item["name"]: item.get("value") for item in entries}
    prefix = values.get("REDIS_KEY_PREFIX", DEFAULT_PREFIX)
    active = values.get("LINE_REDIS_RECOVERY", "null") or "null"
    value = json.loads(active)
    cutoff = values.get("LINE_REDIS_RECOVERY_CUTOFF_MS", "")
    if value is not None:
        fence(value)
        require(prefix == value["prefix"] and cutoff == str(value["cutoffMs"]))
    else:
        require(not cutoff and ":recovery:" not in prefix)
    return prefix, value


def select(candidate, raw):
    prefix, prior = environment(raw)
    if candidate is None:
        candidate = prior  # Normal releases must retain an incident fence indefinitely.
    elif candidate != prior:
        fence(candidate)
        require(candidate["previousPrefix"] == prefix and candidate["prefix"] != prefix)
        require(prior is None or candidate["cutoffMs"] > prior["cutoffMs"])
    if candidate is not None:
        fence(candidate)
    return {"REDIS_KEY_PREFIX": candidate["prefix"] if candidate else prefix,
            "LINE_REDIS_RECOVERY": json.dumps(candidate, separators=(",", ":")),
            "LINE_REDIS_RECOVERY_CUTOFF_MS": str(candidate["cutoffMs"]) if candidate else ""}


def main():
    mode = sys.argv[1]
    if mode == "plan":
        result = plan(json.loads(Path(sys.argv[2]).read_text()))
    elif mode == "select":
        result = select(json.loads(Path(sys.argv[2]).read_text()), os.environ["BOT_ENV_JSON"])
    elif mode == "compatible":
        previous = environment(os.environ["KNOWN_GOOD_ENV_JSON"])
        selected = json.loads(os.environ["RELEASE_RECOVERY_ENV_JSON"])
        current = environment(json.dumps([{"name": k, "value": v} for k, v in selected.items()]))
        result = previous == current
        if result and current[1] is not None:
            for key in ("KNOWN_GOOD_CATALOG_MANIFEST", "KNOWN_GOOD_SCAN_MANIFEST"):
                if key not in os.environ:
                    continue  # Pure identity comparison; release always supplies both keys.
                manifest_path = os.environ[key]
                if not manifest_path:
                    result = False
                    continue
                manifest = json.loads(Path(manifest_path).read_text())
                entries = manifest["properties"]["template"]["containers"][0]["env"]
                if environment(json.dumps(entries)) != current:
                    result = False
    else:
        raise ValueError("redis_recovery_mode_invalid")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, IndexError):
        print("redis_recovery_validation_failed", file=sys.stderr)
        sys.exit(1)
