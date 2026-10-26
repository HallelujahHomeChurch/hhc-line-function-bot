import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoveryAllowsEvent, recoveryCutoff } from "../application/recovery/redis-recovery.js";

const cutoff = 1792960000000;
const id = "cb9c8b8f-8f59-47af-a79c-302fbf916512";
const prefix = `hhc-line-function-bot:recovery:${id}`;
const directories: string[] = [];
const hash = "a".repeat(64);
function journal() {
  return {
    version: 1,
    incident: "full_loss",
    operationId: id,
    previousPrefix: "hhc-line-function-bot",
    prefix,
    cutoffMs: cutoff,
    lossFromMs: cutoff - 1000,
    retiredPrefixes: ["hhc-line-function-bot"],
    inventoryComplete: true,
    owners: Object.fromEntries(
      ["api", "attachment_app", "attachment_job", "catalog_job", "webhook_delivery", "queues"].map(
        (name) => [name, { heldAndDrained: true, evidenceSha256: hash }]
      )
    ),
    queuesQuarantinedOrDrained: true,
    queueEvidenceSha256: hash,
    oldApprovalsRetired: true,
    noAutomaticReplay: true,
    effects: [
      {
        correlationSha256: hash,
        status: "unknown",
        disposition: "quarantined",
        evidenceKind: "quarantine_record",
        evidenceSha256: hash
      }
    ]
  };
}
function cli(mode: string, data: unknown, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "line-recovery-"));
  directories.push(directory);
  const file = join(directory, "input.json");
  writeFileSync(file, JSON.stringify(data));
  return spawnSync("python3", ["scripts/redis-recovery.py", mode, file], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env }
  });
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true })));

describe("offline Redis loss recovery", () => {
  it.each(["full_loss", "partial_loss", "stale_restore"])(
    "keeps uncertain effects quarantined for %s",
    (incident) => {
      const result = cli("plan", { ...journal(), incident });
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.counts).toEqual({ completed: 0, not_started: 0, unknown: 1 });
      expect(output.evidence).toBe("operator_attestations_not_machine_proof");
      expect(output.candidate.prefix).toBe(prefix);
    }
  );
  it.each([
    { incident: "oom_retained" },
    { inventoryComplete: false },
    { owners: {} },
    { queuesQuarantinedOrDrained: false },
    { oldApprovalsRetired: false },
    { retiredPrefixes: ["hhc-line-function-bot", prefix] },
    { noAutomaticReplay: false },
    {
      effects: [
        {
          correlationSha256: hash,
          status: "not_started",
          disposition: "no_replay",
          evidenceKind: "missing_receipt",
          evidenceSha256: hash
        }
      ]
    },
    {
      effects: [
        {
          correlationSha256: hash,
          status: "unknown",
          disposition: "retry",
          evidenceKind: "quarantine_record",
          evidenceSha256: hash
        }
      ]
    }
  ])("refuses unsafe reopening evidence %j", (change) => {
    expect(cli("plan", { ...journal(), ...change }).status).toBe(1);
  });
  it("requires positive owner evidence even for a not-started classification", () => {
    const input = journal();
    input.effects[0] = {
      correlationSha256: hash,
      status: "not_started",
      disposition: "no_replay",
      evidenceKind: "durable_pre_dispatch_record",
      evidenceSha256: hash
    };
    expect(cli("plan", input).status).toBe(0);
  });
  it("retains recovery on later normal releases and rejects a namespace or cutoff downgrade", () => {
    const candidate = JSON.parse(cli("plan", journal()).stdout).candidate;
    const selected = JSON.parse(cli("select", candidate, { BOT_ENV_JSON: "[]" }).stdout);
    const env = {
      BOT_ENV_JSON: JSON.stringify(
        Object.entries(selected).map(([name, value]) => ({ name, value }))
      )
    };
    expect(JSON.parse(cli("select", null, env).stdout)).toEqual(selected);
    expect(cli("select", { ...candidate, cutoffMs: cutoff - 1 }, env).status).toBe(1);
    expect(cli("select", { ...candidate, previousPrefix: prefix }, env).status).toBe(1);
    expect(
      cli("compatible", null, {
        RELEASE_RECOVERY_ENV_JSON: JSON.stringify(selected),
        KNOWN_GOOD_ENV_JSON: "[]"
      }).stdout.trim()
    ).toBe("false");
    expect(
      cli("compatible", null, {
        RELEASE_RECOVERY_ENV_JSON: JSON.stringify(selected),
        KNOWN_GOOD_ENV_JSON: env.BOT_ENV_JSON
      }).stdout.trim()
    ).toBe("true");
  });
});

describe("recovery rollback saved job inputs", () => {
  it("refuses an older saved job namespace despite an identical API fence", () => {
    const candidate = JSON.parse(cli("plan", journal()).stdout).candidate;
    const selected = JSON.parse(cli("select", candidate, { BOT_ENV_JSON: "[]" }).stdout);
    const entries = Object.entries(selected).map(([name, value]) => ({ name, value }));
    const directory = mkdtempSync(join(tmpdir(), "line-recovery-job-"));
    directories.push(directory);
    const path = join(directory, "job.json");
    const env = {
      RELEASE_RECOVERY_ENV_JSON: JSON.stringify(selected),
      KNOWN_GOOD_ENV_JSON: JSON.stringify(entries),
      KNOWN_GOOD_CATALOG_MANIFEST: path,
      KNOWN_GOOD_SCAN_MANIFEST: path
    };
    writeFileSync(
      path,
      JSON.stringify({ properties: { template: { containers: [{ env: [] }] } } })
    );
    expect(cli("compatible", null, env).stdout.trim()).toBe("false");
    writeFileSync(
      path,
      JSON.stringify({ properties: { template: { containers: [{ env: entries }] } } })
    );
    expect(cli("compatible", null, env).stdout.trim()).toBe("true");
    writeFileSync(path, "invalid");
    expect(cli("compatible", null, env).status).toBe(1);
  });
});

describe("recovery signed-event boundary", () => {
  it.each([
    undefined,
    null,
    {},
    { timestamp: "1792960000001" },
    { timestamp: cutoff },
    { timestamp: cutoff - 1 },
    { timestamp: Infinity },
    { timestamp: cutoff + 60_001 }
  ])("rejects old, missing or invalid event time %j", (event) => {
    expect(recoveryAllowsEvent(event, cutoff, cutoff)).toBe(false);
  });
  it("accepts a new valid event and requires a matching independent namespace identity", () => {
    expect(recoveryAllowsEvent({ timestamp: cutoff + 1 }, cutoff, cutoff + 1)).toBe(true);
    const env = {
      REDIS_KEY_PREFIX: prefix,
      LINE_REDIS_RECOVERY_CUTOFF_MS: String(cutoff),
      LINE_REDIS_RECOVERY: JSON.stringify({ prefix, cutoffMs: cutoff })
    };
    expect(recoveryCutoff(env)).toBe(cutoff);
    expect(() => recoveryCutoff({ ...env, REDIS_KEY_PREFIX: "hhc-line-function-bot" })).toThrow();
    expect(() => recoveryCutoff({ ...env, LINE_REDIS_RECOVERY_CUTOFF_MS: "" })).toThrow();
  });
});
