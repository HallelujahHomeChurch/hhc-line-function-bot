import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAssuranceReport, type AssuranceReportInput } from "../assurance/report.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
const PERIODIC_IMAGE_DIGEST = `sha256:${"7".repeat(64)}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

describe("periodic assurance shell runner", () => {
  it("starts one immutable job execution, observes recent scans, and writes an allowlisted report", async () => {
    const fixture = await createFixture("success");

    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(0);
    const reportText = await readFile(fixture.reportPath, "utf8");
    const report = JSON.parse(reportText) as AssuranceReportInput;

    expect(() => buildAssuranceReport(report), reportText).not.toThrow();
    expect(report).toMatchObject({
      version: 1,
      kind: "periodic",
      releaseId: "periodic-17",
      commitSha: "a".repeat(40),
      status: "passed",
      failureCode: "none",
      target: {
        resource: "periodic_assurance",
        revision: "periodic-exec-17",
        image: PERIODIC_IMAGE_DIGEST,
        status: "ready"
      },
      knownGood: {
        revision: "hhc-line-bot-periodic-assurance",
        image: PERIODIC_IMAGE_DIGEST
      },
      rollback: { status: "not_required" },
      providerRequests: { deepseek: 0, embedding: 0 }
    });
    expect(report.checks).toHaveLength(7);
    expect(report.checks.every((check) => check.status !== "failed")).toBe(true);
    expect(reportText).not.toContain("private-registry");
    expect(reportText).not.toContain("fake-private-error");
    expectJobLifecycle(calls, { polls: 2, logs: 1 });
    expectRecentScanObservation(calls);
    expectForbiddenCallsAbsent(calls);
  });

  it("preserves a sanitized periodic failure without retrying the job", async () => {
    const fixture = await createFixture("periodic_and_scan_failure");

    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(1);
    const reportText = await readFile(fixture.reportPath, "utf8");
    const report = JSON.parse(reportText) as AssuranceReportInput;

    expect(() => buildAssuranceReport(report), reportText).not.toThrow();
    expect(report.status).toBe("failed");
    expect(report.failureCode).toBe("graph_metadata_failed");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "graph_metadata",
        status: "failed",
        code: "graph_metadata_failed"
      })
    );
    expect(report.providerRequests).toEqual({ deepseek: 0, embedding: 0 });
    expect(reportText).not.toContain("fake-private-error");
    expectJobLifecycle(calls, { polls: 1, logs: 1 });
    expectRecentScanObservation(calls);
    expectForbiddenCallsAbsent(calls);
  });

  it.each([
    {
      scenario: "clamav_failure_and_scan_failure",
      check: "clamav_eicar",
      code: "clamav_eicar_failed"
    },
    {
      scenario: "diagnostic_failure_and_malformed_scan",
      check: "diagnostic_write_delete",
      code: "diagnostic_delete_failed"
    }
  ])(
    "preserves late workload failure $code over later control-plane failures",
    async ({ scenario, check, code }) => {
      const fixture = await createFixture(scenario);

      const result = fixture.run();
      const calls = await fixture.calls();
      expect(result.status, diagnostic(result, calls)).toBe(1);
      const reportText = await readFile(fixture.reportPath, "utf8");
      const report = JSON.parse(reportText) as AssuranceReportInput;

      expect(() => buildAssuranceReport(report), reportText).not.toThrow();
      expect(report.failureCode).toBe(code);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ name: check, status: "failed", code })
      );
      expect(reportText).not.toContain("fake-private-error");
      expectJobLifecycle(calls, { polls: 1, logs: 1 });
      expectRecentScanObservation(calls);
      expectForbiddenCallsAbsent(calls);
    }
  );

  it.each([
    ["failed_check_with_none", "failed", "none"],
    ["passed_check_with_failure_code", "passed", "graph_metadata_failed"],
    ["warning_check_with_none", "warning", "none"]
  ])(
    "fails closed and writes a failed report for malformed %s invariant (%s/%s)",
    async (scenario) => {
      const fixture = await createFixture(scenario);

      const result = fixture.run();
      const calls = await fixture.calls();
      expect(result.status, diagnostic(result, calls)).toBe(1);
      const reportText = await readFile(fixture.reportPath, "utf8");
      const report = JSON.parse(reportText) as AssuranceReportInput;

      expect(() => buildAssuranceReport(report), reportText).not.toThrow();
      expect(report.status).toBe("failed");
      expect(report.failureCode).toBe("malformed_json");
      expect(report.checks).toEqual([]);
      expect(reportText).not.toContain("fake-private-error");
      expectJobLifecycle(calls, { polls: 1, logs: 1 });
      expectForbiddenCallsAbsent(calls);
    }
  );

  it("bounds execution polling and never starts a replacement execution", async () => {
    const fixture = await createFixture("timeout");

    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(1);
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(() => buildAssuranceReport(report)).not.toThrow();
    expect(report.status).toBe("failed");
    expect(report.failureCode).toBe("timeout");
    expect(report.target.status).toBe("failed");
    expect(report.providerRequests).toEqual({ deepseek: 0, embedding: 0 });
    expectJobLifecycle(calls, { polls: 3, logs: 0 });
    expect(calls.filter((args) => args[0] === "sleep")).toHaveLength(2);
    expectRecentScanObservation(calls);
    expectForbiddenCallsAbsent(calls);
  });

  it("writes a network-failed artifact when Azure authentication is unavailable", async () => {
    const fixture = await createFixture("azure_unavailable");

    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(1);
    const reportText = await readFile(fixture.reportPath, "utf8");
    const report = JSON.parse(reportText) as AssuranceReportInput;

    expect(() => buildAssuranceReport(report), reportText).not.toThrow();
    expect(report.status).toBe("failed");
    expect(report.failureCode).toBe("network_failed");
    expect(report.checks).toEqual([]);
    expect(reportText).not.toContain("fake-private-auth-error");
    expect(calls.some((args) => command(args, "containerapp", "job", "start"))).toBe(false);
    expectRecentScanObservation(calls);
    expectForbiddenCallsAbsent(calls);
  });

  it("fails the attachment control-plane check when a recent scan execution failed", async () => {
    const fixture = await createFixture("recent_scan_failure");

    const result = fixture.run();
    const calls = await fixture.calls();
    expect(result.status, diagnostic(result, calls)).toBe(1);
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(() => buildAssuranceReport(report)).not.toThrow();
    expect(report.status).toBe("failed");
    expect(report.failureCode).toBe("http_mismatch");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "attachment_queue",
        status: "failed",
        code: "http_mismatch"
      })
    );
    expectJobLifecycle(calls, { polls: 2, logs: 1 });
    expectRecentScanObservation(calls);
    expectForbiddenCallsAbsent(calls);
  });
});

async function createFixture(scenario: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "periodic-assurance-script-"));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const stateDirectory = path.join(directory, "state");
  const callLogPath = path.join(directory, "calls.jsonl");
  const reportPath = path.join(directory, "periodic-report.json");
  const driverPath = path.join(directory, "driver.sh");
  await Promise.all([mkdir(binDirectory), mkdir(stateDirectory)]);
  await writeFile(path.join(binDirectory, "az"), FAKE_AZ, { mode: 0o700 });
  await writeFile(
    path.join(binDirectory, "sleep"),
    '#!/usr/bin/env bash\nprintf \'["sleep","%s"]\\n\' "$1" >> "${FAKE_AZ_LOG}"\n',
    { mode: 0o700 }
  );
  await writeFile(
    driverPath,
    `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="${toBashPath(binDirectory)}:\${PATH}"
export FAKE_AZ_LOG="${toBashPath(callLogPath)}"
export FAKE_AZ_STATE="${toBashPath(stateDirectory)}"
export FAKE_SCENARIO="${scenario}"
export RESOURCE_GROUP="fixture-resource-group"
export PERIODIC_ASSURANCE_JOB_NAME="hhc-line-bot-periodic-assurance"
export ATTACHMENT_SCAN_JOB_NAME="hhc-line-bot-attachment-scan"
export PERIODIC_REPORT_PATH="${toBashPath(reportPath)}"
export PERIODIC_RUN_ID="periodic-17"
export PERIODIC_COMMIT_SHA="${"a".repeat(40)}"
export PERIODIC_POLL_ATTEMPTS="3"
export PERIODIC_POLL_INTERVAL_SECONDS="1"
export PERIODIC_RECENT_SCAN_MAX_AGE_SECONDS="604800"
exec bash "${toBashPath(path.join(ROOT, "scripts/run-periodic-assurance.sh"))}"
`,
    { mode: 0o700 }
  );

  return {
    reportPath,
    run: () =>
      spawnSync("bash", [toBashPath(driverPath)], {
        cwd: ROOT,
        encoding: "utf8"
      }),
    calls: async (): Promise<string[][]> => {
      const text = await readFile(callLogPath, "utf8").catch(() => "");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    }
  };
}

function expectJobLifecycle(calls: string[][], expected: { polls: number; logs: number }): void {
  expect(
    calls.filter(
      (args) =>
        command(args, "containerapp", "job", "start") &&
        value(args, "--name") === "hhc-line-bot-periodic-assurance"
    )
  ).toHaveLength(1);
  expect(
    calls.filter(
      (args) =>
        command(args, "containerapp", "job", "execution", "show") &&
        value(args, "--name") === "hhc-line-bot-periodic-assurance" &&
        value(args, "--job-execution-name") === "periodic-exec-17"
    )
  ).toHaveLength(expected.polls);
  expect(
    calls.filter(
      (args) =>
        command(args, "containerapp", "job", "logs", "show") &&
        value(args, "--name") === "hhc-line-bot-periodic-assurance" &&
        value(args, "--execution") === "periodic-exec-17"
    )
  ).toHaveLength(expected.logs);
}

function expectRecentScanObservation(calls: string[][]): void {
  expect(
    calls.filter(
      (args) =>
        command(args, "containerapp", "job", "execution", "list") &&
        value(args, "--name") === "hhc-line-bot-attachment-scan"
    )
  ).toHaveLength(1);
}

function expectForbiddenCallsAbsent(calls: string[][]): void {
  const flattened = calls.map((args) => args.join(" ")).join("\n");
  expect(flattened).not.toMatch(/\btraffic\b/iu);
  expect(flattened).not.toMatch(/\b(update|create|delete|stop)\b/iu);
  expect(flattened).not.toMatch(/deepseek|embedding|chat.?completion/iu);
  expect(
    calls.some(
      (args) =>
        command(args, "containerapp", "job", "start") &&
        value(args, "--name") === "hhc-line-bot-attachment-scan"
    )
  ).toBe(false);
}

function command(args: string[], ...parts: string[]): boolean {
  return parts.every((part, index) => args[index] === part);
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function diagnostic(result: ReturnType<typeof spawnSync>, calls: string[][]): string {
  return `${String(result.stdout)}\n${String(result.stderr)}\n${JSON.stringify(calls, null, 2)}`;
}

function toBashPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/u.exec(normalized);
  return match ? `/mnt/${match[1]!.toLowerCase()}/${match[2]}` : normalized;
}

const FAKE_AZ = `#!/usr/bin/env python3
import datetime
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
with open(os.environ["FAKE_AZ_LOG"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(args, separators=(",", ":")) + "\\n")
scenario = os.environ["FAKE_SCENARIO"]
state = Path(os.environ["FAKE_AZ_STATE"])

def command(*parts):
    return all(index < len(args) and args[index] == part for index, part in enumerate(parts))

def value(flag):
    try:
        return args[args.index(flag) + 1]
    except (ValueError, IndexError):
        return None

if scenario == "azure_unavailable":
    print("fake-private-auth-error", file=sys.stderr)
    sys.exit(17)

if command("containerapp", "job", "show"):
    print("private-registry.example/fixture/scan@${PERIODIC_IMAGE_DIGEST}")
elif command("containerapp", "job", "start"):
    print("periodic-exec-17")
elif command("containerapp", "job", "execution", "show"):
    count_path = state / "poll-count"
    count = int(count_path.read_text() or "0") + 1 if count_path.exists() else 1
    count_path.write_text(str(count))
    if scenario == "timeout":
        print("Running")
    elif scenario in {
        "periodic_and_scan_failure",
        "clamav_failure_and_scan_failure",
        "diagnostic_failure_and_malformed_scan",
        "failed_check_with_none",
        "passed_check_with_failure_code",
        "warning_check_with_none",
    }:
        print("Failed")
    else:
        print("Running" if count == 1 else "Succeeded")
elif command("containerapp", "job", "execution", "list"):
    if scenario == "diagnostic_failure_and_malformed_scan":
        print("{malformed-scan-observation")
        sys.exit(0)
    started = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=5)
    ).isoformat().replace("+00:00", "Z")
    print(json.dumps({
        "name":"scan-exec-3",
        "status":"Failed" if scenario in {"periodic_and_scan_failure", "clamav_failure_and_scan_failure", "recent_scan_failure"} else "Succeeded",
        "startTime":started,
    }))
elif command("containerapp", "job", "logs", "show"):
    checks = [
        {"name":"graph_metadata","status":"passed","code":"none"},
        {"name":"notion_query","status":"passed","code":"none"},
        {"name":"attachment_queue","status":"passed","code":"none"},
        {"name":"clamav_signature","status":"passed","code":"none"},
        {"name":"clamav_clean","status":"passed","code":"none"},
        {"name":"clamav_eicar","status":"passed","code":"none"},
        {"name":"diagnostic_write_delete","status":"passed","code":"none"},
    ]
    failures = {
        "periodic_and_scan_failure": ("graph_metadata", "graph_metadata_failed"),
        "clamav_failure_and_scan_failure": ("clamav_eicar", "clamav_eicar_failed"),
        "diagnostic_failure_and_malformed_scan": ("diagnostic_write_delete", "diagnostic_delete_failed"),
    }
    if scenario in failures:
        failed_name, failed_code = failures[scenario]
        row = next(item for item in checks if item["name"] == failed_name)
        row.update({"status":"failed","code":failed_code})
    elif scenario == "failed_check_with_none":
        checks[0].update({"status":"failed","code":"none"})
    elif scenario == "passed_check_with_failure_code":
        checks[0].update({"status":"passed","code":"graph_metadata_failed"})
    elif scenario == "warning_check_with_none":
        checks[3].update({"status":"warning","code":"none"})
    failed = any(item["status"] == "failed" for item in checks)
    payload = {
        "status":"failed" if failed else "passed",
        "checks":checks,
        "queue":{"depth":0,"oldestAgeSeconds":None},
        "providerRequests":{"deepseek":0,"embedding":0},
    }
    print(json.dumps([
        {"TimeStamp":"2026-07-27T01:00:00Z","Log":"fake-private-error: do not serialize"},
        {"TimeStamp":"2026-07-27T01:00:01Z","Log":json.dumps(payload, separators=(",", ":"))},
    ]))
else:
    print("unexpected fake az command: " + " ".join(args), file=sys.stderr)
    sys.exit(91)
`;
