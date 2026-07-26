import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAssuranceReport, type AssuranceReportInput } from "../assurance/report.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
const GOOD_BOT_DIGEST = `sha256:${"1".repeat(64)}`;
const GOOD_CATALOG_DIGEST = `sha256:${"2".repeat(64)}`;
const GOOD_SCAN_DIGEST = `sha256:${"3".repeat(64)}`;
const GOOD_REFRESH_DIGEST = `sha256:${"4".repeat(64)}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

describe("release assurance shell transaction", () => {
  it("captures known-good state, runs live gates, and writes an allowlisted digest-only report", async () => {
    const fixture = await createFixture("success");
    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(0);
    const reportText = await readFile(fixture.reportPath, "utf8");
    const report = JSON.parse(reportText) as AssuranceReportInput;

    expect(() => buildAssuranceReport(report)).not.toThrow();
    expect(report.status).toBe("passed");
    expect(report.failureCode).toBe("none");
    expect(report.knownGood).toEqual({
      revision: "bot--known-good",
      image: GOOD_BOT_DIGEST
    });
    expect(report.target).toEqual({
      resource: "bot",
      revision: "bot--target",
      image: `sha256:${"9".repeat(64)}`,
      status: "ready"
    });
    expect(report.rollback).toEqual({ status: "not_required" });
    expect(report.providerRequests).toEqual({ deepseek: 0, embedding: 0 });
    expect(report.checks.map((check) => check.name)).toHaveLength(
      new Set(report.checks.map((check) => check.name)).size
    );
    expect(Object.keys(report).sort()).toEqual(
      [
        "checks",
        "commitSha",
        "completedAt",
        "failureCode",
        "kind",
        "knownGood",
        "providerRequests",
        "releaseId",
        "rollback",
        "startedAt",
        "status",
        "target",
        "version"
      ].sort()
    );
    expect(reportText).not.toContain("fixture-secret");
    expect(reportText).not.toContain("internal.example");
    expect(reportText).not.toContain("missing_line_signature");
    expect(reportText).not.toContain("registry.example");
    expect(calls.some((args) => isJobStart(args, "hhc-line-bot-release-probe"))).toBe(true);
    expect(calls.some((args) => args.includes("revision") && args.includes("copy"))).toBe(false);
    expectForbiddenCallsAbsent(calls);
  });

  it("preserves a pre-mutation failure without attempting rollback", async () => {
    const fixture = await createFixture("pre_mutation_failure");
    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(23);
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(report.status).toBe("failed");
    expect(report.failureCode).toBe("network_failed");
    expect(report.rollback).toEqual({ status: "not_required" });
    expect(calls.some((args) => args.includes("revision") && args.includes("copy"))).toBe(false);
    expect(calls.some((args) => args.includes("job") && args.includes("update"))).toBe(false);
  });

  it.each([
    "target_revision_mismatch",
    "target_image_mismatch",
    "target_traffic_mismatch",
    "bot_ingress_mismatch",
    "bot_dapr_mismatch",
    "release_probe_failure",
    "searxng_definition_failure",
    "catalog_definition_failure",
    "catalog_no_recent_success",
    "refresh_definition_failure",
    "scan_definition_failure"
  ])("fails the %s gate and performs a verified rollback", async (scenario) => {
    const fixture = await createFixture(scenario);
    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(42);
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;
    const copy = calls.find((args) => args.includes("revision") && args.includes("copy"));

    expect(report.status).toBe("failed");
    expect(report.failureCode).not.toBe("none");
    if (scenario === "bot_ingress_mismatch") {
      expect(report.failureCode).toBe("http_mismatch");
    }
    expect(report.rollback).toEqual({
      status: "restored",
      revision: "bot--rollback",
      image: GOOD_BOT_DIGEST
    });
    expect(copy).toEqual(expect.arrayContaining(["copy", "--from-revision", "bot--known-good"]));
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "job",
        "update",
        "--name",
        "hhc-line-bot-catalog-sync",
        "--image",
        `registry.example/fixture-secret/catalog@${GOOD_CATALOG_DIGEST}`
      ])
    );
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "job",
        "update",
        "--name",
        "hhc-line-bot-attachment-scan",
        "--image",
        `registry.example/fixture-secret/scan@${GOOD_SCAN_DIGEST}`
      ])
    );
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "job",
        "update",
        "--name",
        "hhc-line-bot-clamav-refresh",
        "--image",
        `registry.example/fixture-secret/refresh@${GOOD_REFRESH_DIGEST}`
      ])
    );
    expectForbiddenCallsAbsent(calls);
  });

  it.each(["rollback_copy_failure", "rollback_image_mismatch"])(
    "preserves the original gate exit and failure code when %s occurs",
    async (scenario) => {
      const fixture = await createFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();
      expect(result.status, diagnostic(result, calls)).toBe(42);
      const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

      expect(report.status).toBe("failed");
      expect(report.failureCode).toBe("http_mismatch");
      expect(report.rollback.status).toBe("failed");
      expectForbiddenCallsAbsent(calls);
    }
  );
});

async function createFixture(scenario: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-assurance-"));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const stateDirectory = path.join(directory, "state");
  const callLogPath = path.join(directory, "calls.jsonl");
  const reportPath = path.join(directory, "report.json");
  const driverPath = path.join(directory, "driver.sh");
  await Promise.all([mkdir(binDirectory), mkdir(stateDirectory)]);
  await writeFile(path.join(binDirectory, "az"), FAKE_AZ, { mode: 0o700 });
  await writeFile(
    path.join(binDirectory, "node"),
    `#!/usr/bin/env bash
if [[ -n "\${FAKE_SYSTEM_NODE:-}" ]]; then
  script_path="$1"
  shift
  exec "\${FAKE_SYSTEM_NODE}" "\${script_path}" \
    --fake-log "\${FAKE_AZ_LOG}" \
    --fake-state "\${FAKE_AZ_STATE}" \
    --fake-scenario "\${FAKE_SCENARIO}" \
    "$@"
fi
script_path="$(wslpath -w "$1")"
shift
exec /mnt/c/nvm4w/nodejs/node.exe "\${script_path}" \
  --fake-log "$(wslpath -w "\${FAKE_AZ_LOG}")" \
  --fake-state "$(wslpath -w "\${FAKE_AZ_STATE}")" \
  --fake-scenario "\${FAKE_SCENARIO}" \
  "$@"
`,
    { mode: 0o700 }
  );
  await writeFile(
    path.join(binDirectory, "sleep"),
    '#!/usr/bin/env bash\nprintf \'["sleep","%s"]\\n\' "$1" >> "${FAKE_AZ_LOG}"\n',
    { mode: 0o700 }
  );
  await writeFile(
    driverPath,
    `#!/usr/bin/env bash
set -Eeuo pipefail
export FAKE_SYSTEM_NODE="$(command -v node || true)"
export PATH="${toBashPath(binDirectory)}:\${PATH}"
export FAKE_AZ_LOG="${toBashPath(callLogPath)}"
export FAKE_AZ_STATE="${toBashPath(stateDirectory)}"
export FAKE_SCENARIO="${scenario}"
export RESOURCE_GROUP="fixture-resource-group"
export CONTAINER_APP_NAME="fixture-bot"
export SEARXNG_CONTAINER_APP_NAME="fixture-searxng"
export CATALOG_SYNC_JOB_NAME="hhc-line-bot-catalog-sync"
export ATTACHMENT_SCAN_JOB_NAME="hhc-line-bot-attachment-scan"
export CLAMAV_SIGNATURE_REFRESH_JOB_NAME="hhc-line-bot-clamav-refresh"
export RELEASE_PROBE_JOB_NAME="hhc-line-bot-release-probe"
export PERIODIC_ASSURANCE_JOB_NAME="hhc-line-bot-periodic-assurance"
export RELEASE_REPORT_PATH="${toBashPath(reportPath)}"
export RELEASE_ID="fixture-release-17"
export RELEASE_COMMIT_SHA="${"a".repeat(40)}"
export RELEASE_POLL_ATTEMPTS="3"
export RELEASE_POLL_INTERVAL_SECONDS="1"
source "${toBashPath(path.join(ROOT, "scripts/release-assurance.sh"))}"
trap 'release_assurance_on_exit "$?"' EXIT
capture_known_good_state
if [[ "\${FAKE_SCENARIO}" == "pre_mutation_failure" ]]; then
  set_release_failure "preflight_failed"
  exit 23
fi
mark_release_mutated
mark_release_job_mutated "hhc-line-bot-clamav-refresh"
mark_release_job_mutated "hhc-line-bot-attachment-scan"
mark_release_job_mutated "hhc-line-bot-catalog-sync"
RELEASE_TARGET_REVISION="bot--target"
RELEASE_TARGET_IMAGE="registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}"
RELEASE_TARGET_SCAN_IMAGE="registry.example/fixture-secret/scan@sha256:${"8".repeat(64)}"
RELEASE_CLAMAV_BOOTSTRAP_EXECUTION_NAME="refresh-exec-current"
if ! run_release_gates; then
  exit 42
fi
write_release_report
complete_release_transaction
`,
    { mode: 0o700 }
  );

  return {
    reportPath,
    run: () => spawnSync("bash", [toBashPath(driverPath)], { cwd: ROOT, encoding: "utf8" }),
    calls: async (): Promise<string[][]> => {
      const text = await readFile(callLogPath, "utf8").catch(() => "");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[][][number]);
    }
  };
}

function isJobStart(args: string[], name: string): boolean {
  return (
    args[0] === "containerapp" &&
    args[1] === "job" &&
    args[2] === "start" &&
    args[args.indexOf("--name") + 1] === name
  );
}

function expectForbiddenCallsAbsent(calls: string[][]): void {
  const flattened = calls.map((args) => args.join(" ")).join("\n");
  expect(flattened).not.toMatch(/chat.?completion/iu);
  expect(flattened).not.toMatch(/embedding/iu);
  expect(calls.some((args) => isJobStart(args, "hhc-line-bot-catalog-sync"))).toBe(false);
  expect(flattened).not.toContain("missing_line_signature");
  expect(flattened).not.toMatch(/\bcurl\b/iu);
}

function diagnostic(result: ReturnType<typeof spawnSync>, calls: string[][]): string {
  return `${String(result.stdout)}\n${String(result.stderr)}\n${JSON.stringify(calls, null, 2)}`;
}

function toBashPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/u.exec(normalized);
  return match ? `/mnt/${match[1]!.toLowerCase()}/${match[2]}` : normalized;
}

const FAKE_AZ = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const control = {};
while (rawArgs[0]?.startsWith("--fake-")) {
  control[rawArgs.shift()] = rawArgs.shift();
}
const args = rawArgs;
appendFileSync(control["--fake-log"], JSON.stringify(args) + "\\n");
const scenario = control["--fake-scenario"];
const state = control["--fake-state"];
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const command = (...parts) => parts.every((part, index) => args[index] === part);
const output = (body) => process.stdout.write(typeof body === "string" ? body : JSON.stringify(body));
const name = value("--name");
const query = value("--query");
const oldImages = {
  "hhc-line-bot-catalog-sync": "registry.example/fixture-secret/catalog@${GOOD_CATALOG_DIGEST}",
  "hhc-line-bot-attachment-scan": "registry.example/fixture-secret/scan@${GOOD_SCAN_DIGEST}",
  "hhc-line-bot-clamav-refresh": "registry.example/fixture-secret/refresh@${GOOD_REFRESH_DIGEST}"
};
const targetImages = {
  "hhc-line-bot-catalog-sync": "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}",
  "hhc-line-bot-attachment-scan": "registry.example/fixture-secret/scan@sha256:${"8".repeat(64)}",
  "hhc-line-bot-clamav-refresh": "registry.example/fixture-secret/scan@sha256:${"8".repeat(64)}",
  "hhc-line-bot-release-probe": "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}",
  "hhc-line-bot-periodic-assurance": "registry.example/fixture-secret/scan@sha256:${"8".repeat(64)}"
};

if (command("containerapp", "show") && name === "fixture-bot") {
  if (query === "properties.latestReadyRevisionName") output("bot--known-good");
  else if (query === "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,dapr:properties.configuration.dapr}") {
    const rolledBack = existsSync(path.join(state, "rollback"));
    output({
      latestRevision: rolledBack ? "bot--rollback" : "bot--target",
      latestReadyRevision: rolledBack
        ? "bot--rollback"
        : scenario === "target_revision_mismatch"
          ? "bot--known-good"
          : "bot--target",
      runningStatus: "Running",
      traffic:
        scenario === "target_traffic_mismatch" ||
        scenario === "rollback_copy_failure" ||
        scenario === "rollback_image_mismatch"
          ? [{ revisionName: "bot--known-good", weight: 100 }]
          : [{ revisionName: rolledBack ? "bot--rollback" : "bot--target", weight: 100 }],
      external: false,
      targetPort: scenario === "bot_ingress_mismatch" ? 3001 : 3000,
      dapr:
        scenario === "bot_dapr_mismatch"
          ? { enabled: false, appId: "wrong", appPort: 1, appProtocol: "tcp" }
          : {
              enabled: true,
              appId: "hhc-line-function-bot",
              appPort: 3000,
              appProtocol: "http"
            }
    });
  } else process.exit(91);
  process.exit(0);
}

if (command("containerapp", "revision", "show")) {
  if (query !== "properties.template.containers[0].image") process.exit(92);
  const revision = value("--revision");
  if (revision === "bot--known-good") {
    output("registry.example/fixture-secret/bot@${GOOD_BOT_DIGEST}");
  } else if (revision === "bot--target") {
    output(
      scenario === "target_image_mismatch"
        ? "registry.example/fixture-secret/bot@sha256:${"7".repeat(64)}"
        : "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}"
    );
  } else if (revision === "bot--rollback") {
    output(
      scenario === "rollback_image_mismatch"
        ? "registry.example/fixture-secret/bot@sha256:${"6".repeat(64)}"
        : "registry.example/fixture-secret/bot@${GOOD_BOT_DIGEST}"
    );
  } else process.exit(93);
  process.exit(0);
}

if (command("containerapp", "show") && name === "fixture-searxng") {
  if (query !== "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,minReplicas:properties.template.scale.minReplicas,cpu:properties.template.containers[0].resources.cpu,memory:properties.template.containers[0].resources.memory,image:properties.template.containers[0].image}") process.exit(94);
  output({
    latestRevision: "searx--ready",
    latestReadyRevision: "searx--ready",
    runningStatus: "Running",
    external: false,
    targetPort: 8080,
    minReplicas: 1,
    cpu: scenario === "searxng_definition_failure" ? 1 : 0.25,
    memory: "0.5Gi",
    image: "docker.io/searxng/searxng@sha256:${"5".repeat(64)}"
  });
  process.exit(0);
}

if (command("containerapp", "job", "show")) {
  if (query === "properties.template.containers[0].image") {
    const snapshot = path.join(state, "snapshot-" + name);
    const restored = existsSync(path.join(state, "restored-" + name));
    if (!existsSync(snapshot)) {
      writeFileSync(snapshot, "1");
      output(oldImages[name]);
    } else {
      output(restored ? oldImages[name] : targetImages[name]);
    }
    process.exit(0);
  }
  if (query !== "{triggerType:properties.configuration.triggerType,replicaTimeout:properties.configuration.replicaTimeout,replicaRetryLimit:properties.configuration.replicaRetryLimit,schedule:properties.configuration.scheduleTriggerConfig,event:properties.configuration.eventTriggerConfig,manual:properties.configuration.manualTriggerConfig,image:properties.template.containers[0].image}") process.exit(95);
  const definitions = {
    "hhc-line-bot-catalog-sync": {
      triggerType: "Schedule",
      replicaTimeout: 600,
      replicaRetryLimit: 1,
      schedule: { parallelism: 1, replicaCompletionCount: 1 }
    },
    "hhc-line-bot-attachment-scan": {
      triggerType: "Event",
      replicaTimeout: 900,
      replicaRetryLimit: 1,
      event: { parallelism: 1, replicaCompletionCount: 1 }
    },
    "hhc-line-bot-clamav-refresh": {
      triggerType: "Schedule",
      replicaTimeout: 900,
      replicaRetryLimit: 1,
      schedule: { parallelism: 1, replicaCompletionCount: 1 }
    },
    "hhc-line-bot-release-probe": {
      triggerType: "Manual",
      replicaTimeout: 300,
      replicaRetryLimit: 0,
      manual: { parallelism: 1, replicaCompletionCount: 1 }
    },
    "hhc-line-bot-periodic-assurance": {
      triggerType: "Manual",
      replicaTimeout: 600,
      replicaRetryLimit: 0,
      manual: { parallelism: 1, replicaCompletionCount: 1 }
    }
  };
  const definition = { ...definitions[name], image: targetImages[name] };
  if (scenario === "catalog_definition_failure" && name === "hhc-line-bot-catalog-sync") definition.replicaTimeout = 1;
  if (scenario === "refresh_definition_failure" && name === "hhc-line-bot-clamav-refresh") definition.replicaTimeout = 1;
  if (scenario === "scan_definition_failure" && name === "hhc-line-bot-attachment-scan") definition.replicaTimeout = 1;
  output(definition);
  process.exit(0);
}

if (command("containerapp", "job", "start")) {
  if (name !== "hhc-line-bot-release-probe") process.exit(96);
  output("probe-exec-current");
  process.exit(0);
}

if (command("containerapp", "job", "execution", "show")) {
  const execution = value("--job-execution-name");
  if (name === "hhc-line-bot-release-probe" && execution === "probe-exec-current") {
    output(scenario === "release_probe_failure" ? "Failed" : "Succeeded");
  } else if (name === "hhc-line-bot-clamav-refresh" && execution === "refresh-exec-current") {
    output("Succeeded");
  } else process.exit(97);
  process.exit(0);
}

if (command("containerapp", "job", "execution", "list")) {
  if (name !== "hhc-line-bot-catalog-sync") process.exit(98);
  output({
    name: "catalog-observed",
    status: "Succeeded",
    startTime:
      scenario === "catalog_no_recent_success"
        ? "2000-01-01T00:00:00.000Z"
        : new Date().toISOString()
  });
  process.exit(0);
}

if (command("containerapp", "revision", "copy")) {
  if (scenario === "rollback_copy_failure") process.exit(73);
  writeFileSync(path.join(state, "rollback"), "1");
  output("bot--rollback");
  process.exit(0);
}

if (command("containerapp", "job", "update")) {
  if (!args.includes("--image") || !oldImages[name]) process.exit(99);
  writeFileSync(path.join(state, "restored-" + name), "1");
  process.exit(0);
}

process.stderr.write("Unexpected fake az call: " + args.join(" ") + "\\n");
process.exit(100);
`;
