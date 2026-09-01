import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAssuranceReport, type AssuranceReportInput } from "../assurance/report.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
const GOOD_BOT_DIGEST = `sha256:${"1".repeat(64)}`;
const GOOD_CATALOG_DIGEST = `sha256:${"2".repeat(64)}`;
const GOOD_SCAN_DIGEST = `sha256:${"3".repeat(64)}`;
const GOOD_RELEASE_PROBE_DIGEST = `sha256:${"5".repeat(64)}`;
const GOOD_PERIODIC_DIGEST = `sha256:${"6".repeat(64)}`;
const MAIN_EMPTY_WEBHOOK_SIGNATURE = Buffer.alloc(32, 1).toString("base64");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

describe("release assurance shell transaction", () => {
  it.each(["missing_manifest", "known_good_capture_failure"])(
    "writes an allowlisted report without rollback for deploy-time %s",
    async (scenario) => {
      const fixture = await createDeployFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();

      expect(result.status, diagnostic(result, calls)).not.toBe(0);
      const reportText = await readFile(fixture.reportPath, "utf8").catch((error: unknown) => {
        throw new Error(`${diagnostic(result, calls)}\n${String(error)}`);
      });
      const report = JSON.parse(reportText) as AssuranceReportInput;
      expect(() => buildAssuranceReport(report)).not.toThrow();
      expect(report.status).toBe("failed");
      expect(report.failureCode).toBe("network_failed");
      expect(report.knownGood.revision).toBe("unavailable");
      expect(report.rollback).toEqual({ status: "not_required" });
      expect(calls.some((args) => args.includes("revision") && args.includes("copy"))).toBe(false);
      expect(calls.some((args) => args.includes("job") && args.includes("update"))).toBe(false);
    }
  );

  it("writes an early report when required deployment environment is missing", async () => {
    const fixture = await createDeployFixture("missing_environment");
    const result = fixture.run();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status).not.toBe(0);
    expect(report.status).toBe("failed");
    expect(report.failureCode).toBe("network_failed");
    expect(report.rollback).toEqual({ status: "not_required" });
  });

  it("fails a blank account presentation preflight before snapshot or external writes", async () => {
    const fixture = await createDeployFixture("missing_account_presentation");
    const result = fixture.run();
    const calls = await fixture.calls();
    const flattened = calls.map((args) => args.join(" ")).join("\n");

    expect(result.status, diagnostic(result, calls)).not.toBe(0);
    expect(result.stderr, diagnostic(result, calls)).toContain(
      "Required ACA environment reference is unavailable"
    );
    expect(flattened).toContain("properties.template.containers[0].env");
    expect(flattened).not.toContain("properties.latestReadyRevisionName");
    expect(flattened).not.toMatch(
      /containerapp (?:secret set|update|create|revision copy)|containerapp env storage set|containerapp job (?:update|create)/u
    );
  });

  it("fails a mismatched manual LINE Provider checkpoint before snapshot or external writes", async () => {
    const fixture = await createDeployFixture("provider_console_mismatch");
    const result = fixture.run();
    const calls = await fixture.calls();
    const flattened = calls.map((args) => args.join(" ")).join("\n");

    expect(result.status, diagnostic(result, calls)).not.toBe(0);
    expect(result.stderr, diagnostic(result, calls)).toContain("LINE Provider Console checkpoint");
    expect(flattened).not.toContain("properties.latestReadyRevisionName");
    expect(flattened).not.toMatch(
      /containerapp (?:secret set|update|create|revision copy)|containerapp env storage set|containerapp job (?:update|create)/u
    );
  });

  it.each([
    ["missing helper", ["release_probe", "gateway_main_signed_empty_webhook"], true],
    ["missing main", ["release_probe", "gateway_helper_signed_empty_webhook"], true],
    [
      "duplicate passed check",
      [
        "release_probe",
        "gateway_helper_signed_empty_webhook",
        "gateway_main_signed_empty_webhook",
        "release_probe"
      ],
      true
    ],
    ["duplicate failed check", ["release_probe", "release_probe"], false]
  ])("rejects a shell-written %s report", async (_case, checkNames, passed) => {
    const fixture = await createReportWriterFixture(checkNames, passed);
    const result = fixture.run();

    expect(result.status).not.toBe(0);
    await expect(readFile(fixture.reportPath, "utf8")).rejects.toThrow();
  });

  it("allows a shell-written early failed report with partial checks", async () => {
    const fixture = await createReportWriterFixture(["release_probe"], false);
    const result = fixture.run();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status).toBe(0);
    expect(() => buildAssuranceReport(report)).not.toThrow();
    expect(report.checks.map((check) => check.name)).toEqual(["release_probe"]);
  });

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
    expect(reportText).not.toContain(MAIN_EMPTY_WEBHOOK_SIGNATURE);
    expect(calls.some((args) => isJobStart(args, "hhc-line-bot-release-probe"))).toBe(true);
    expect(calls.some((args) => args.slice(0, 2).join(" ") === "containerapp exec")).toBe(true);
    expect(calls.some((args) => args.slice(0, 4).join(" ") === "containerapp job logs show")).toBe(
      false
    );
    expect(calls.some((args) => args.slice(0, 3).join(" ") === "monitor log-analytics query")).toBe(
      true
    );
    const analyticsCall = calls.find(
      (args) => args.slice(0, 3).join(" ") === "monitor log-analytics query"
    );
    const analyticsQuery = analyticsCall?.[analyticsCall.indexOf("--analytics-query") + 1] ?? "";
    expect(analyticsQuery.indexOf("| order by TimeGenerated asc")).toBeLessThan(
      analyticsQuery.indexOf("| project Log_s")
    );
    expect(calls.some((args) => args.includes("revision") && args.includes("copy"))).toBe(false);
    expectForbiddenCallsAbsent(calls);
  }, 15_000);

  it("rolls back when the bounded Account preflight fails", async () => {
    const fixture = await createFixture("account_preflight_failure");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.failureCode).toBe("http_mismatch");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "account_preflight", status: "failed" })
    );
    expect(report.rollback.status).toBe("restored");
  }, 15_000);

  it.each(["release_probe_replica_gone", "release_probe_logs_missing"])(
    "falls back to durable Log Analytics for %s",
    async (scenario) => {
      const fixture = await createFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();
      const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

      expect(result.status, diagnostic(result, calls)).toBe(0);
      expect(report.status).toBe("passed");
      expect(calls).toContainEqual(
        expect.arrayContaining(["containerapp", "env", "show", "--name", "fixture-env"])
      );
      expect(
        calls.some((args) => args.slice(0, 3).join(" ") === "monitor log-analytics query")
      ).toBe(true);
      expectForbiddenCallsAbsent(calls);
    },
    15_000
  );

  it("resolves a pre-R5 tagged known-good image to its actual OCI digest before rollback", async () => {
    const fixture = await createFixture("known_good_tag");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.knownGood.image).toBe(GOOD_BOT_DIGEST);
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "acr",
        "manifest",
        "show-metadata",
        "--name",
        "alive/hhc-line-function-bot:main-legacy",
        "--query",
        "digest"
      ])
    );
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "revision",
        "copy",
        "--from-revision",
        "bot--known-good",
        "--image",
        `registry.example/alive/hhc-line-function-bot@${GOOD_BOT_DIGEST}`
      ])
    );
  }, 15_000);

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
    ["source load", "preseeded_provider_contract_pre_mutation_failure", 23],
    ["gate entry", "preseeded_provider_contract_target_failure", 42]
  ])(
    "does not trust a provider-contract flag preseeded before %s",
    async (_boundary, scenario, expectedExit) => {
      const fixture = await createFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();
      const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

      expect(result.status, diagnostic(result, calls)).toBe(expectedExit);
      expect(report.status).toBe("failed");
      expect(report).not.toHaveProperty("providerRequests");
    },
    15_000
  );

  it.each(["empty_catalog_snapshot", "empty_scan_snapshot"])(
    "fails an incomplete %s before any mutation",
    async (scenario) => {
      const fixture = await createFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();
      const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

      expect(result.status, diagnostic(result, calls)).not.toBe(0);
      expect(report.status).toBe("failed");
      expect(report.rollback).toEqual({ status: "not_required" });
      expect(report).not.toHaveProperty("providerRequests");
      expect(calls.some((args) => args.includes("revision") && args.includes("copy"))).toBe(false);
      expect(calls.some((args) => args.includes("job") && args.includes("update"))).toBe(false);
      expect(calls.some((args) => args.includes("job") && args.includes("start"))).toBe(false);
    }
  );

  it.each(["job_list_failure", "searxng_list_failure"])(
    "fails safely when resource existence cannot be established for %s",
    async (scenario) => {
      const fixture = await createFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();
      const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

      expect(result.status, diagnostic(result, calls)).not.toBe(0);
      expect(report.status).toBe("failed");
      expect(report.rollback).toEqual({ status: "not_required" });
      expect(calls.some((args) => args.includes("delete"))).toBe(false);
      expect(calls.some((args) => args.includes("update"))).toBe(false);
    }
  );

  it.each([
    "target_revision_mismatch",
    "target_image_mismatch",
    "target_traffic_mismatch",
    "bot_ingress_mismatch",
    "bot_ingress_transport_mismatch",
    "bot_dapr_mismatch",
    "release_probe_failure",
    "searxng_definition_failure",
    "searxng_traffic_mismatch",
    "searxng_transport_mismatch",
    "searxng_scale_mismatch",
    "searxng_image_mismatch",
    "catalog_definition_failure",
    "catalog_cron_mismatch",
    "catalog_image_mismatch",
    "catalog_hmac_env_mismatch",
    "catalog_no_recent_success",
    "scan_definition_failure",
    "scan_scaler_mismatch",
    "scan_resources_mismatch",
    "scan_mount_mismatch",
    "scan_clamav_env_mismatch",
    "release_probe_args_mismatch",
    "release_probe_env_mismatch",
    "release_probe_resources_mismatch",
    "release_probe_mount_mismatch",
    "release_probe_provider_env",
    "periodic_args_mismatch",
    "periodic_env_mismatch",
    "periodic_resources_mismatch",
    "periodic_mount_mismatch",
    "periodic_provider_env"
  ])(
    "fails the %s gate and performs a verified rollback",
    async (scenario) => {
      const fixture = await createFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();
      expect(result.status, diagnostic(result, calls)).toBe(42);
      const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;
      const copy = calls.find((args) => args.includes("revision") && args.includes("copy"));

      expect(report.status).toBe("failed");
      expect(report.failureCode).not.toBe("none");
      if (
        scenario.startsWith("target_") ||
        scenario.startsWith("bot_") ||
        scenario.startsWith("searxng_") ||
        scenario.includes("definition") ||
        scenario.includes("_cron_") ||
        scenario.includes("_image_") ||
        scenario.includes("_scaler_") ||
        scenario.includes("_resources_") ||
        scenario.includes("_mount_") ||
        scenario.includes("_args_") ||
        scenario.includes("_env_") ||
        scenario.includes("_provider_")
      ) {
        expect(report).not.toHaveProperty("providerRequests");
      }
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
        expect.arrayContaining(["job", "update", "--name", "hhc-line-bot-catalog-sync", "--yaml"])
      );
      expect(calls).toContainEqual(
        expect.arrayContaining([
          "job",
          "update",
          "--name",
          "hhc-line-bot-attachment-worker",
          "--yaml"
        ])
      );
      expect(calls).toContainEqual(
        expect.arrayContaining(["job", "update", "--name", "hhc-line-bot-release-probe", "--yaml"])
      );
      expect(calls).toContainEqual(
        expect.arrayContaining([
          "job",
          "update",
          "--name",
          "hhc-line-bot-periodic-assurance",
          "--yaml"
        ])
      );
      expectForbiddenCallsAbsent(calls);
    },
    30_000
  );

  it("records actual release probe child failures", async () => {
    const scenario = "release_probe_child_failure";
    const failureCode = "bot_health_failed";
    const fixture = await createFixture(scenario);
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;
    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.failureCode).toBe(failureCode);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "bot_health", status: "failed" })
    );
    expect(calls.some((args) => args.slice(0, 4).join(" ") === "containerapp job logs show")).toBe(
      false
    );
    expect(calls.some((args) => args.slice(0, 3).join(" ") === "monitor log-analytics query")).toBe(
      true
    );
  }, 15_000);

  it.each(["release_probe_logs_malformed", "release_probe_logs_multiple"])(
    "fails closed when %s",
    async (scenario) => {
      const fixture = await createFixture(scenario);
      const result = fixture.run();
      const calls = await fixture.calls();
      const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

      expect(result.status, diagnostic(result, calls)).toBe(42);
      expect(report.status).toBe("failed");
      expect(report.failureCode).toBe("malformed_json");
      expect(report.checks.some((check) => check.name === "bot_health")).toBe(false);
    },
    15_000
  );

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
      expect(report.rollback).toEqual(
        scenario === "rollback_copy_failure"
          ? { status: "failed" }
          : {
              status: "failed",
              revision: "bot--rollback",
              image: `sha256:${"6".repeat(64)}`
            }
      );
      if (scenario !== "rollback_copy_failure") {
        expect(calls).toContainEqual(
          expect.arrayContaining([
            "revision",
            "show",
            "--name",
            "fixture-bot",
            "--revision",
            "bot--rollback"
          ])
        );
      }
      expectForbiddenCallsAbsent(calls);
    },
    30_000
  );

  it("does not report restored when a job definition differs from its snapshot", async () => {
    const fixture = await createFixture("job_restore_definition_mismatch");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.rollback.status).toBe("failed");
    expect(calls).toContainEqual(
      expect.arrayContaining(["job", "update", "--name", "hhc-line-bot-catalog-sync", "--yaml"])
    );
  }, 15_000);

  it("restores the worker definition and verifies it", async () => {
    const fixture = await createFixture("worker_restore_definition_mismatch");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.rollback.status).toBe("failed");
    const update = calls.find(
      (args) =>
        args.slice(0, 3).join(" ") === "containerapp job update" &&
        args.includes("hhc-line-bot-attachment-worker")
    );
    expect(update).toContain("--yaml");
  }, 15_000);

  it("does not report restored when a job keeps the wrong image", async () => {
    const fixture = await createFixture("job_restore_image_mismatch");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.rollback.status).toBe("failed");
  }, 15_000);

  it("restores the snapshotted SearXNG revision before reporting rollback restored", async () => {
    const fixture = await createFixture("searxng_restore");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.rollback.status).toBe("restored");
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "revision",
        "copy",
        "--name",
        "fixture-searxng",
        "--from-revision",
        "searx--ready",
        "--image",
        `docker.io/searxng/searxng@sha256:${"5".repeat(64)}`
      ])
    );
  }, 15_000);

  it("accepts Azure's no-op copy when the snapshotted SearXNG revision remains fully restored", async () => {
    const fixture = await createFixture("searxng_restore_noop");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.rollback.status).toBe("restored");
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "revision",
        "show",
        "--name",
        "fixture-searxng",
        "--revision",
        "searx--ready"
      ])
    );
  }, 15_000);

  it("does not report restored when the copied SearXNG contract is wrong", async () => {
    const fixture = await createFixture("searxng_restore_contract_mismatch");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.rollback.status).toBe("failed");
  }, 15_000);

  it("removes assurance jobs that did not exist in the known-good snapshot", async () => {
    const fixture = await createFixture("absent_assurance_jobs");
    const result = fixture.run();
    const calls = await fixture.calls();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status, diagnostic(result, calls)).toBe(42);
    expect(report.rollback.status).toBe("restored");
    for (const jobName of ["hhc-line-bot-release-probe", "hhc-line-bot-periodic-assurance"]) {
      expect(calls).toContainEqual(
        expect.arrayContaining(["job", "delete", "--name", jobName, "--yes"])
      );
    }
  }, 15_000);

  it.each(["write", "fsync", "replace"])(
    "does not mark a report durable when its %s step fails",
    async (failureMode) => {
      const fixture = await createFixture(`report_${failureMode}_failure`);
      const result = fixture.run();
      const calls = await fixture.calls();
      const reportFlag = await readFile(fixture.reportFlagPath, "utf8");

      expect(result.status, diagnostic(result, calls)).toBe(31);
      expect(reportFlag).toBe("false");
      await expect(readFile(fixture.reportPath, "utf8")).rejects.toThrow();
      expect(calls.some((args) => args.includes("revision") && args.includes("copy"))).toBe(true);
    }
  );

  it.each([
    ["transaction_incomplete", 1, "network_failed"],
    ["unclassified_release_failure", 27, "network_failed"],
    ["unexpected_release_job", 28, "http_mismatch"]
  ])("maps the emitted %s reason explicitly", async (scenario, expectedExit, expectedCode) => {
    const fixture = await createFixture(scenario);
    const result = fixture.run();
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as AssuranceReportInput;

    expect(result.status).toBe(expectedExit);
    expect(report.failureCode).toBe(expectedCode);
  });

  it("fails closed instead of silently mapping an unknown reason", async () => {
    const fixture = await createFixture("unknown_failure_reason");
    const result = fixture.run();

    expect(result.status).toBe(29);
    await expect(readFile(fixture.reportPath, "utf8")).rejects.toThrow();
  });
});

async function createDeployFixture(scenario: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deploy-release-assurance-"));
  temporaryDirectories.push(directory);
  const scriptsDirectory = path.join(directory, "scripts");
  const binDirectory = path.join(directory, "bin");
  const callLogPath = path.join(directory, "calls.jsonl");
  const reportPath = path.join(directory, "report.json");
  const driverPath = path.join(directory, "driver.sh");
  await Promise.all([mkdir(scriptsDirectory), mkdir(binDirectory)]);
  await Promise.all([
    copyFile(
      path.join(ROOT, "scripts/deploy-aca.sh"),
      path.join(scriptsDirectory, "deploy-aca.sh")
    ),
    copyFile(
      path.join(ROOT, "scripts/release-assurance.sh"),
      path.join(scriptsDirectory, "release-assurance.sh")
    )
  ]);
  if (
    scenario === "known_good_capture_failure" ||
    scenario === "missing_account_presentation" ||
    scenario === "provider_console_mismatch"
  ) {
    await mkdir(path.join(directory, "infra/searxng"), { recursive: true });
    await Promise.all(
      [
        "aca.containerapp.yaml",
        "aca.searxng.containerapp.yaml",
        "aca.catalog-sync-job.yaml",
        "aca.attachment-worker-job.yaml",
        "aca.attachment-worker-app.yaml",
        "aca.media-sync-warmer-job.yaml",
        "aca.release-probe-job.yaml",
        "aca.periodic-assurance-job.yaml"
      ].map((name) => copyFile(path.join(ROOT, name), path.join(directory, name)))
    );
    await copyFile(
      path.join(ROOT, "infra/searxng/settings.yml"),
      path.join(directory, "infra/searxng/settings.yml")
    );
  }
  await writeFile(
    path.join(binDirectory, "az"),
    scenario === "missing_account_presentation" || scenario === "provider_console_mismatch"
      ? accountPresentationAz(callLogPath, scenario === "missing_account_presentation")
      : `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toBashPath(callLogPath)}"
exit 61
`,
    { mode: 0o700 }
  );

  await writeFile(
    driverPath,
    `#!/usr/bin/env bash
export PATH="${toBashPath(binDirectory)}:\${PATH}"
${scenario === "missing_environment" ? "" : 'export ACR_NAME="fixture-acr"'}
export ACR_LOGIN_SERVER="fixture.invalid"
export IMAGE_REPOSITORY="fixture/bot"
export IMAGE_TAG="fixture-tag"
export RESOURCE_GROUP="fixture-resource-group"
export CONTAINER_APP_NAME="fixture-bot"
export CATALOG_SYNC_JOB_NAME="fixture-catalog"
export ATTACHMENT_SCAN_JOB_NAME="fixture-scan"
export ATTACHMENT_WORKER_APP_NAME="fixture-scan-app"
export MEDIA_SYNC_WARMER_JOB_NAME="fixture-warmer"
export RELEASE_PROBE_JOB_NAME="fixture-release-probe"
export PERIODIC_ASSURANCE_JOB_NAME="fixture-periodic"
export ATTACHMENT_SCAN_STORAGE_ACCOUNT_NAME="fixture-attachments"
export ATTACHMENT_SCAN_QUEUE_NAME="fixture-queue"
export MEDIA_SYNC_WARM_QUEUE_NAME="fixture-warm-queue"
export ASSET_API_AUDIENCE="api://fixture-asset"
export MEETING_API_AUDIENCE="api://fixture-meeting"
export LINE_PROVIDER_CONSOLE_VERIFIED_ID="${scenario === "provider_console_mismatch" ? "provider-2" : "provider-1"}"
export RELEASE_REPORT_PATH="${toBashPath(reportPath)}"
export RELEASE_ID="fixture-early-failure"
export RELEASE_COMMIT_SHA="${"a".repeat(40)}"
exec bash "${toBashPath(path.join(scriptsDirectory, "deploy-aca.sh"))}"
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
        .map((line) => line.split(" "));
    }
  };
}

function accountPresentationAz(callLogPath: string, missingMain: boolean): string {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(toBashPath(callLogPath))}, args.join(" ") + "\\n");
const value = (name) => args[args.indexOf(name) + 1];
const query = value("--query");
const name = value("--name");
const command = (...parts) => parts.every((part, index) => args[index] === part);
const output = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));

if (command("acr", "manifest", "show-metadata")) output("sha256:${"1".repeat(64)}");
else if (command("containerapp", "show") && name === "fixture-bot" && query === "properties.managedEnvironmentId") output("/subscriptions/fixture/managedEnvironments/fixture-env");
else if (command("containerapp", "show") && name === "fixture-bot" && query === "location") output("eastasia");
else if (command("identity", "show") && query === "id") output("/identities/fixture-jobs");
else if (command("identity", "show")) output({ id: "/identities/fixture-attachment", clientId: "attachment-client", principalId: "attachment-principal" });
else if (command("containerapp", "show") && name === "asset-api") output("asset.internal.example");
else if (command("containerapp", "show") && name === "hhc-web-api") output("meeting.internal.example");
else if (command("storage", "account", "show")) output("/storage/fixture-attachments");
else if (command("acr", "show")) output("/acr/fixture");
else if (command("role", "assignment", "list")) output("1");
else if (command("ad", "sp", "show")) output({ id: "asset-sp", appRoles: [{ id: "asset-role", value: "Asset.Invoke", isEnabled: true, allowedMemberTypes: ["Application"] }] });
else if (command("rest")) output({ value: [{ appRoleId: "asset-role", resourceId: "asset-sp" }] });
else if (command("containerapp", "auth", "show")) output({ platform: { enabled: true }, globalValidation: { unauthenticatedClientAction: "Return401" }, identityProviders: { azureActiveDirectory: { validation: { defaultAuthorizationPolicy: { allowedApplications: ["attachment-client"], allowedPrincipals: { identities: ["attachment-principal"] } } } } } });
else if (command("cognitiveservices", "account", "show")) output("https://embedding.example/");
else if (command("cognitiveservices", "account", "deployment", "list")) output({ properties: { provisioningState: "Succeeded", model: { name: "text-embedding-3-small" } } });
else if (command("containerapp", "show") && name === "fixture-bot" && query === "properties.template.containers[0].env") output([
  { name: "LINE_HELPER_ACCOUNT_ID", value: "@helper" },
  { name: "LINE_MAIN_ACCOUNT_ID", value: ${JSON.stringify(missingMain ? "   " : "@main")} },
  { name: "LINE_ACCOUNT_PROVIDER_ID", value: "provider-1" }
]);
else process.exit(90);
`;
}

async function createReportWriterFixture(checkNames: string[], passed: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-report-writer-"));
  temporaryDirectories.push(directory);
  const reportPath = path.join(directory, "report.json");
  const driverPath = path.join(directory, "driver.sh");
  const records = checkNames
    .map((name) => `${name}|passed|2026-07-27T00:00:00.000Z|none`)
    .join("\\n");
  await writeFile(
    driverPath,
    `#!/usr/bin/env bash
set -euo pipefail
source "${toBashPath(path.join(ROOT, "scripts/release-assurance.sh"))}"
export RELEASE_REPORT_PATH="${toBashPath(reportPath)}"
export RELEASE_ID="fixture-release-writer"
export RELEASE_COMMIT_SHA="${"a".repeat(40)}"
export RELEASE_KNOWN_GOOD_REVISION="bot--known-good"
export RELEASE_KNOWN_GOOD_IMAGE="${GOOD_BOT_DIGEST}"
export RELEASE_TARGET_REVISION="bot--target"
export RELEASE_TARGET_IMAGE="${GOOD_BOT_DIGEST}"
export RELEASE_CHECK_RECORDS=$'${records}\\n'
export RELEASE_FAILURE_REASON="${passed ? "none" : "preflight_failed"}"
export RELEASE_PROVIDER_CONTRACT_VERIFIED="${passed ? "true" : "false"}"
write_release_report
`,
    { mode: 0o700 }
  );
  return {
    reportPath,
    run: () => spawnSync("bash", [toBashPath(driverPath)], { cwd: ROOT, encoding: "utf8" })
  };
}

async function createFixture(scenario: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-assurance-"));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const stateDirectory = path.join(directory, "state");
  const callLogPath = path.join(directory, "calls.jsonl");
  const reportPath = path.join(directory, "report.json");
  const reportFlagPath = path.join(stateDirectory, "report-flag");
  const driverPath = path.join(directory, "driver.sh");
  await Promise.all([mkdir(binDirectory), mkdir(stateDirectory)]);
  await writeFile(
    path.join(directory, "sitecustomize.py"),
    `import json
import os

mode = os.environ.get("FAKE_REPORT_IO_FAILURE")
if mode == "write":
    def fail_dump(*_args, **_kwargs):
        raise OSError("injected report write failure")
    json.dump = fail_dump
elif mode == "fsync":
    def fail_fsync(*_args, **_kwargs):
        raise OSError("injected report fsync failure")
    os.fsync = fail_fsync
elif mode == "replace":
    def fail_replace(*_args, **_kwargs):
        raise OSError("injected report replace failure")
    os.replace = fail_replace
`
  );
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
    path.join(binDirectory, "script"),
    `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-c" ]]; then
    shift
    exec bash -c "$1"
  fi
  shift
done
exit 2
`,
    { mode: 0o700 }
  );
  await writeFile(
    path.join(binDirectory, "timeout"),
    `#!/usr/bin/env bash
shift
exec "$@"
`,
    { mode: 0o700 }
  );
  await writeFile(
    driverPath,
    `#!/usr/bin/env bash
set -Eeuo pipefail
export FAKE_SYSTEM_NODE="$(command -v node || true)"
export PATH="${toBashPath(binDirectory)}:\${PATH}"
export PYTHONPATH="${toBashPath(directory)}"
export FAKE_AZ_LOG="${toBashPath(callLogPath)}"
export FAKE_AZ_STATE="${toBashPath(stateDirectory)}"
export FAKE_SCENARIO="${scenario}"
export FAKE_REPORT_IO_FAILURE="${scenario.startsWith("report_") ? scenario.slice(7, -8) : ""}"
export RESOURCE_GROUP="fixture-resource-group"
export ACR_NAME="fixture-acr"
export ACR_LOGIN_SERVER="registry.example"
export CONTAINER_APP_NAME="fixture-bot"
export SEARXNG_CONTAINER_APP_NAME="fixture-searxng"
export CATALOG_SYNC_JOB_NAME="hhc-line-bot-catalog-sync"
export ATTACHMENT_SCAN_JOB_NAME="hhc-line-bot-attachment-worker"
export ATTACHMENT_WORKER_APP_NAME="hhc-line-bot-attachment-app"
export MEDIA_SYNC_WARMER_JOB_NAME="hhc-line-bot-media-sync-warmer"
export RELEASE_PROBE_JOB_NAME="hhc-line-bot-release-probe"
export PERIODIC_ASSURANCE_JOB_NAME="hhc-line-bot-periodic-assurance"
export managed_environment_name="fixture-env"
export RELEASE_REPORT_PATH="${toBashPath(reportPath)}"
export RELEASE_ID="fixture-release-17"
export RELEASE_COMMIT_SHA="${"a".repeat(40)}"
export RELEASE_POLL_ATTEMPTS="3"
export RELEASE_POLL_INTERVAL_SECONDS="1"
export RELEASE_EXPECTED_SEARXNG_IMAGE="docker.io/searxng/searxng@sha256:${"5".repeat(64)}"
export RELEASE_PROVIDER_CONTRACT_VERIFIED="${scenario === "preseeded_provider_contract_pre_mutation_failure" ? "true" : "false"}"
source "${toBashPath(path.join(ROOT, "scripts/release-assurance.sh"))}"
trap 'release_assurance_on_exit "$?"' EXIT
capture_known_good_state
if [[ "\${FAKE_SCENARIO}" == "preseeded_provider_contract_target_failure" ]]; then
  RELEASE_PROVIDER_CONTRACT_VERIFIED=true
fi
if [[ "\${FAKE_SCENARIO}" == report_*_failure ]]; then
  mark_release_mutated
  set_release_failure "preflight_failed"
  if write_release_report; then
    printf '%s' "\${RELEASE_REPORT_WRITTEN}" > "${toBashPath(reportFlagPath)}"
    exit 88
  fi
  printf '%s' "\${RELEASE_REPORT_WRITTEN}" > "${toBashPath(reportFlagPath)}"
  exit 31
fi
if [[ "\${FAKE_SCENARIO}" == "transaction_incomplete" ]]; then
  exit 0
fi
if [[ "\${FAKE_SCENARIO}" == "unclassified_release_failure" ]]; then
  exit 27
fi
if [[ "\${FAKE_SCENARIO}" == "unexpected_release_job" ]]; then
  if ! mark_release_job_mutated "unexpected-job"; then
    exit 28
  fi
  exit 89
fi
if [[ "\${FAKE_SCENARIO}" == "unknown_failure_reason" ]]; then
  set_release_failure "unknown_fixture_reason"
  exit 29
fi
if [[ "\${FAKE_SCENARIO}" == "pre_mutation_failure" ]] \
  || [[ "\${FAKE_SCENARIO}" == "preseeded_provider_contract_pre_mutation_failure" ]]; then
  set_release_failure "preflight_failed"
  exit 23
fi
mark_release_mutated
if [[ "\${FAKE_SCENARIO}" == searxng_restore* ]]; then
  mark_release_searxng_mutated
fi
mark_release_job_mutated "hhc-line-bot-attachment-worker"
mark_release_job_mutated "hhc-line-bot-catalog-sync"
mark_release_job_mutated "hhc-line-bot-release-probe"
mark_release_job_mutated "hhc-line-bot-periodic-assurance"
RELEASE_TARGET_REVISION="bot--target"
RELEASE_TARGET_IMAGE="registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}"
RELEASE_TARGET_SCAN_IMAGE="registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}"
RELEASE_TARGET_ATTACHMENT_IMAGE="registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}"
RELEASE_TARGET_ATTACHMENT_APP_IMAGE="registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}"
RELEASE_ATTACHMENT_BOOTSTRAP_EXECUTION_NAME="attachment-exec-current"
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
    reportFlagPath,
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
  "hhc-line-bot-attachment-worker": "registry.example/fixture-secret/scan@${GOOD_SCAN_DIGEST}",
  "hhc-line-bot-media-sync-warmer": "registry.example/fixture-secret/scan@${GOOD_SCAN_DIGEST}",
  "hhc-line-bot-release-probe": "registry.example/fixture-secret/release@${GOOD_RELEASE_PROBE_DIGEST}",
  "hhc-line-bot-periodic-assurance": "registry.example/fixture-secret/periodic@${GOOD_PERIODIC_DIGEST}"
};
const targetImages = {
  "hhc-line-bot-catalog-sync": "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}",
  "hhc-line-bot-attachment-worker": "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}",
  "hhc-line-bot-media-sync-warmer": "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}",
  "hhc-line-bot-release-probe": "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}",
  "hhc-line-bot-periodic-assurance": "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}"
};

if (command("containerapp", "exec")) {
  const failed = scenario === "account_preflight_failure";
  output(
    "ACCOUNT_PREFLIGHT_RESULT=" +
      JSON.stringify({
        status: failed ? "failed" : "passed",
        functions: failed ? [{ name: "update_own_profile", outcome: "missing" }] : [],
        outcomes: { identityLookup: "unbound", binding: "rejected" }
      })
  );
  process.exit(0);
}

if (command("containerapp", "list")) {
  if (scenario === "searxng_list_failure") process.exit(105);
  output(/name=='([^']+)'/.exec(query ?? "")?.[1] ?? "");
  process.exit(0);
}

if (command("containerapp", "job", "list")) {
  if (scenario === "job_list_failure") process.exit(106);
  const requestedName = /name=='([^']+)'/.exec(query ?? "")?.[1];
  const absent =
    scenario === "absent_assurance_jobs" &&
    ["hhc-line-bot-release-probe", "hhc-line-bot-periodic-assurance"].includes(requestedName);
  output(absent ? "" : requestedName ?? "");
  process.exit(0);
}

if (command("containerapp", "show") && name === "fixture-bot") {
  if (query === "properties.latestReadyRevisionName") output("bot--known-good");
  else if (query === "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,transport:properties.configuration.ingress.transport,dapr:properties.configuration.dapr}") {
    const rolledBack = existsSync(path.join(state, "rollback"));
    output({
      latestRevision: rolledBack ? "bot--rollback" : "bot--target",
      latestReadyRevision: rolledBack
        ? "bot--rollback"
        : scenario === "target_revision_mismatch" ||
            scenario === "preseeded_provider_contract_target_failure"
          ? "bot--known-good"
          : "bot--target",
      runningStatus: "Running",
      traffic:
        rolledBack
          ? [{ latestRevision: true, weight: 100 }]
          : scenario === "target_traffic_mismatch" ||
              scenario === "rollback_copy_failure" ||
              scenario === "rollback_image_mismatch"
          ? [{ revisionName: "bot--known-good", weight: 100 }]
          : [{ revisionName: "bot--target", weight: 100 }],
      external: false,
      targetPort: !rolledBack && scenario === "bot_ingress_mismatch" ? 3001 : 3000,
      transport: !rolledBack && scenario === "bot_ingress_transport_mismatch" ? "Tcp" : "Auto",
      dapr:
        !rolledBack && scenario === "bot_dapr_mismatch"
          ? { enabled: false, appId: "wrong", appPort: 1, appProtocol: "tcp" }
          : {
              enabled: true,
              appId: "hhc-line-function-bot",
              appPort: 3000,
              appProtocol: "http",
              appHealth: null,
              enableApiLogging: false,
              httpMaxRequestSize: null,
              httpReadBufferSize: null,
              logLevel: "warn",
              maxConcurrency: null
            }
    });
  } else process.exit(91);
  process.exit(0);
}

if (command("containerapp", "show") && name === "hhc-line-bot-attachment-app") {
  if (query === "properties.template.containers[0].image") {
    output("registry.example/fixture-secret/scan@${GOOD_SCAN_DIGEST}");
  } else if (query === "{image:properties.template.containers[0].image,min:properties.template.scale.minReplicas,max:properties.template.scale.maxReplicas,poll:properties.template.scale.pollingInterval,cooldown:properties.template.scale.cooldownPeriod,rules:properties.template.scale.rules}") {
    output({
      image: "registry.example/fixture-secret/bot@sha256:${"9".repeat(64)}",
      min: scenario === "scan_scaler_mismatch" ? 1 : 0,
      max: 1,
      poll: 1,
      cooldown: 120,
      rules: [{ name: "attachment-work" }, { name: "media-sync-warm" }]
    });
  } else process.exit(109);
  process.exit(0);
}

if (command("containerapp", "revision", "show")) {
  if (query !== "properties.template.containers[0].image") process.exit(92);
  const revision = value("--revision");
  if (
    name === "fixture-searxng" &&
    (revision === "searx--ready" || revision === "searx--rollback")
  ) {
    output("docker.io/searxng/searxng@sha256:${"5".repeat(64)}");
  } else if (revision === "bot--known-good") {
    output(
      scenario === "known_good_tag"
        ? "registry.example/alive/hhc-line-function-bot:main-legacy"
        : "registry.example/fixture-secret/bot@${GOOD_BOT_DIGEST}"
    );
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

if (command("acr", "manifest", "show-metadata")) {
  if (
    value("--registry") !== "fixture-acr" ||
    value("--name") !== "alive/hhc-line-function-bot:main-legacy" ||
    query !== "digest"
  ) process.exit(101);
  output("${GOOD_BOT_DIGEST}");
  process.exit(0);
}

if (command("containerapp", "show") && name === "fixture-searxng") {
  if (query === "properties.latestReadyRevisionName") {
    output("searx--ready");
    process.exit(0);
  }
  if (query === "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,transport:properties.configuration.ingress.transport,minReplicas:properties.template.scale.minReplicas,maxReplicas:properties.template.scale.maxReplicas,cpu:properties.template.containers[0].resources.cpu,memory:properties.template.containers[0].resources.memory}") {
    const restoredRevision =
      scenario === "searxng_restore_noop" ? "searx--ready" : "searx--rollback";
    output({
      latestRevision: restoredRevision,
      latestReadyRevision: restoredRevision,
      runningStatus: "Running",
      traffic: [{ latestRevision: true, weight: 100 }],
      external: false,
      targetPort: 8080,
      transport: scenario === "searxng_restore_contract_mismatch" ? "Auto" : "Http",
      minReplicas: 1,
      maxReplicas: 1,
      cpu: 0.25,
      memory: "0.5Gi"
    });
    process.exit(0);
  }
  if (query !== "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,traffic:properties.configuration.ingress.traffic,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,transport:properties.configuration.ingress.transport,minReplicas:properties.template.scale.minReplicas,maxReplicas:properties.template.scale.maxReplicas,cpu:properties.template.containers[0].resources.cpu,memory:properties.template.containers[0].resources.memory,image:properties.template.containers[0].image}") process.exit(94);
  output({
    latestRevision: "searx--ready",
    latestReadyRevision: "searx--ready",
    runningStatus: "Running",
    traffic:
      scenario === "searxng_traffic_mismatch"
        ? [{ revisionName: "searx--old", weight: 100 }]
        : [{ revisionName: "searx--ready", weight: 100 }],
    external: false,
    targetPort: 8080,
    transport: scenario === "searxng_transport_mismatch" ? "Auto" : "Http",
    minReplicas: scenario === "searxng_scale_mismatch" ? 0 : 1,
    maxReplicas: 1,
    cpu: scenario === "searxng_definition_failure" ? 1 : 0.25,
    memory: "0.5Gi",
    image:
      scenario === "searxng_image_mismatch"
        ? "docker.io/searxng/searxng@sha256:${"6".repeat(64)}"
        : "docker.io/searxng/searxng@sha256:${"5".repeat(64)}"
  });
  process.exit(0);
}

if (command("containerapp", "job", "show")) {
  const manifestQuery = "{name:name,type:type,location:location,identity:{type:identity.type,userAssignedIdentities:identity.userAssignedIdentities},properties:{environmentId:properties.environmentId,configuration:{registries:properties.configuration.registries,triggerType:properties.configuration.triggerType,replicaTimeout:properties.configuration.replicaTimeout,replicaRetryLimit:properties.configuration.replicaRetryLimit,scheduleTriggerConfig:properties.configuration.scheduleTriggerConfig,eventTriggerConfig:properties.configuration.eventTriggerConfig,manualTriggerConfig:properties.configuration.manualTriggerConfig},template:properties.template}}";
  if (query === "properties.template.containers[0].image") {
    const snapshot = path.join(state, "snapshot-" + name);
    const restored = existsSync(path.join(state, "restored-" + name));
    if (!existsSync(snapshot)) {
      writeFileSync(snapshot, "1");
      if (
        scenario === "absent_assurance_jobs" &&
        (name === "hhc-line-bot-release-probe" ||
          name === "hhc-line-bot-periodic-assurance")
      ) process.exit(44);
      const emptySnapshot =
        (scenario === "empty_catalog_snapshot" && name === "hhc-line-bot-catalog-sync") ||
        scenario === "empty_scan_snapshot" && name === "hhc-line-bot-attachment-worker";
      output(emptySnapshot ? "" : oldImages[name]);
    } else {
      output(
        scenario === "job_restore_image_mismatch" &&
          restored &&
          name === "hhc-line-bot-catalog-sync"
          ? "registry.example/fixture-secret/catalog@sha256:${"4".repeat(64)}"
          : restored
            ? oldImages[name]
            : targetImages[name]
      );
    }
    process.exit(0);
  }
  if (query === manifestQuery) {
    const manifestSnapshot = path.join(state, "manifest-snapshot-" + name);
    const firstObservation = !existsSync(manifestSnapshot);
    const restored = existsSync(path.join(state, "restored-" + name));
    if (firstObservation) writeFileSync(manifestSnapshot, "1");
    output({
      name,
      type: "Microsoft.App/jobs",
      location: "fixture-region",
      identity: {
        type: "UserAssigned",
        userAssignedIdentities: { "/fixture/identity": {} }
      },
      properties: {
        environmentId: "/fixture/environment",
        configuration: {
          registries: [{ server: "registry.example", identity: "/fixture/identity" }],
          triggerType: "Manual",
          replicaTimeout:
            ((scenario === "job_restore_definition_mismatch" &&
              name === "hhc-line-bot-catalog-sync") ||
              (scenario === "worker_restore_definition_mismatch" &&
                name === "hhc-line-bot-attachment-worker")) &&
            restored
              ? 1
              : 600,
          replicaRetryLimit: 0,
          scheduleTriggerConfig: null,
          eventTriggerConfig: null,
          manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
        },
        template: {
          containers: [
            {
              name: "fixture-job",
              image: firstObservation || restored ? oldImages[name] : targetImages[name],
              args: ["fixture.js"],
              env: [],
              resources: { cpu: 0.25, memory: "0.5Gi" }
            }
          ],
          volumes: []
        }
      }
    });
    process.exit(0);
  }
  if (query !== "{triggerType:properties.configuration.triggerType,replicaTimeout:properties.configuration.replicaTimeout,replicaRetryLimit:properties.configuration.replicaRetryLimit,schedule:properties.configuration.scheduleTriggerConfig,event:properties.configuration.eventTriggerConfig,manual:properties.configuration.manualTriggerConfig,image:properties.template.containers[0].image,args:properties.template.containers[0].args,env:properties.template.containers[0].env,resources:properties.template.containers[0].resources,volumeMounts:properties.template.containers[0].volumeMounts,volumes:properties.template.volumes}") process.exit(95);
  const definitions = {
    "hhc-line-bot-catalog-sync": {
      triggerType: "Schedule",
      replicaTimeout: 600,
      replicaRetryLimit: 1,
      schedule: {
        cronExpression: "*/15 * * * *",
        parallelism: 1,
        replicaCompletionCount: 1
      },
      args: ["dist/tools/sync-catalog.js"],
      env: [
        {
          name: "OBSERVABILITY_HMAC_KEY",
          secretRef: "observability-hmac-key"
        }
      ],
      resources: {},
      volumeMounts: [],
      volumes: []
    },
    "hhc-line-bot-attachment-worker": {
      triggerType: "Manual",
      replicaTimeout: 1800,
      replicaRetryLimit: 1,
      manual: { parallelism: 1, replicaCompletionCount: 1 },
      args: ["dist/tools/run-attachment-worker.js"],
      env: [
        { name: "ATTACHMENT_SCAN_QUEUE_URL", value: "https://queue.example/scan" },
        { name: "ASSET_API_URL", value: "https://asset.internal.example" },
        { name: "ASSET_API_AUDIENCE", value: "api://asset-api" },
        { name: "AZURE_CLIENT_ID", value: "11111111-1111-4111-8111-111111111111" },
        { name: "MEDIA_SYNC_MAX_BYTES", value: "209715200" },
        { name: "MAX_ATTACHMENT_BYTES", value: "26214400" }
      ],
      resources: { cpu: 0.5, memory: "1Gi" },
      volumeMounts: [],
      volumes: []
    },
    "hhc-line-bot-media-sync-warmer": {
      triggerType: "Schedule",
      replicaTimeout: 120,
      replicaRetryLimit: 1,
      schedule: {
        cronExpression: "*/1 * * * *",
        parallelism: 1,
        replicaCompletionCount: 1
      },
      args: ["dist/tools/run-media-sync-warmer.js"],
      env: [
        { name: "MEETING_API_BASE_URL", value: "https://meeting.internal.example" },
        { name: "MEETING_API_AUDIENCE", value: "api://meeting-api" },
        { name: "MEDIA_SYNC_WARM_QUEUE_URL", value: "https://queue.example/warm" },
        { name: "MEDIA_SYNC_WARM_LEAD", value: "5m" },
        { name: "MEDIA_SYNC_WARM_TAIL", value: "10m" },
        { name: "AZURE_CLIENT_ID", value: "11111111-1111-4111-8111-111111111111" }
      ],
      resources: { cpu: 0.25, memory: "0.5Gi" },
      volumeMounts: [],
      volumes: []
    },
    "hhc-line-bot-release-probe": {
      triggerType: "Manual",
      replicaTimeout: 300,
      replicaRetryLimit: 0,
      manual: { parallelism: 1, replicaCompletionCount: 1 },
      args: ["dist/tools/run-release-probe.js"],
      env: [
        { name: "BOT_BASE_URL", value: "https://bot.internal.example" },
        { name: "SEARXNG_BASE_URL", value: "https://searx.internal.example" },
        {
          name: "GATEWAY_WEBHOOK_URL",
          value: "https://gateway.example/api/line/webhook/helper"
        },
        {
          name: "GATEWAY_MAIN_WEBHOOK_URL",
          value: "https://gateway.example/api/line/webhook/main"
        },
        { name: "LINE_HELPER_CHANNEL_SECRET", secretRef: "line-helper-channel-secret" },
        { name: "LINE_MAIN_EMPTY_WEBHOOK_SIGNATURE", value: "${MAIN_EMPTY_WEBHOOK_SIGNATURE}" }
      ],
      resources: { cpu: 0.25, memory: "0.5Gi", ephemeralStorage: "" },
      volumeMounts: [],
      volumes: []
    },
    "hhc-line-bot-periodic-assurance": {
      triggerType: "Manual",
      replicaTimeout: 600,
      replicaRetryLimit: 0,
      manual: { parallelism: 1, replicaCompletionCount: 1 },
      args: ["dist/tools/run-periodic-assurance.js"],
      env: [
        { name: "GRAPH_TENANT_ID", value: "tenant-fixture" },
        { name: "GRAPH_CLIENT_ID", value: "client-fixture" },
        { name: "GRAPH_CLIENT_SECRET", secretRef: "graph-client-secret" },
        { name: "GRAPH_DRIVE_ID", value: "drive-fixture" },
        { name: "GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID", value: "folder-fixture" },
        { name: "NOTION_TOKEN", secretRef: "notion-token" },
        { name: "NOTION_SERVICE_DATABASE_ID", value: "notion-fixture" },
        {
          name: "ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING",
          secretRef: "attachment-scan-queue-connection-string"
        },
        { name: "ATTACHMENT_SCAN_QUEUE_NAME", value: "queue-fixture" },
        { name: "ASSET_API_URL", value: "https://asset.internal.example" },
        { name: "ASSET_API_AUDIENCE", value: "api://asset-api" },
        { name: "AZURE_CLIENT_ID", value: "11111111-1111-4111-8111-111111111111" }
      ],
      resources: { cpu: 0.25, memory: "0.5Gi", ephemeralStorage: "" },
      volumeMounts: [],
      volumes: []
    }
  };
  const definition = { ...definitions[name], image: targetImages[name] };
  if (scenario === "catalog_definition_failure" && name === "hhc-line-bot-catalog-sync") definition.replicaTimeout = 1;
  if (scenario === "catalog_cron_mismatch" && name === "hhc-line-bot-catalog-sync") definition.schedule.cronExpression = "0 * * * *";
  if (scenario === "catalog_image_mismatch" && name === "hhc-line-bot-catalog-sync") definition.image = "registry.example/fixture-secret/bot@sha256:${"7".repeat(64)}";
  if (scenario === "catalog_hmac_env_mismatch" && name === "hhc-line-bot-catalog-sync") definition.env = [];
  if (scenario === "scan_definition_failure" && name === "hhc-line-bot-attachment-worker") definition.replicaTimeout = 1;
  if (scenario === "scan_resources_mismatch" && name === "hhc-line-bot-attachment-worker") definition.resources.memory = "4Gi";
  if (scenario === "scan_mount_mismatch" && name === "hhc-line-bot-attachment-worker") definition.volumes.push({ name: "unexpected", storageType: "AzureFile", storageName: "unexpected" });
  if (scenario === "scan_clamav_env_mismatch" && name === "hhc-line-bot-attachment-worker") definition.env.push({ name: "CLAMAV_SIGNATURE_MANIFEST_PATH", value: "/retired" });
  if (scenario === "release_probe_args_mismatch" && name === "hhc-line-bot-release-probe") definition.args = ["dist/tools/wrong.js"];
  if (scenario === "release_probe_env_mismatch" && name === "hhc-line-bot-release-probe") definition.env = definition.env.filter((entry) => entry.name !== "BOT_BASE_URL");
  if (scenario === "release_probe_resources_mismatch" && name === "hhc-line-bot-release-probe") definition.resources.cpu = 1;
  if (scenario === "release_probe_mount_mismatch" && name === "hhc-line-bot-release-probe") definition.volumes.push({ name: "unexpected" });
  if (scenario === "release_probe_provider_env" && name === "hhc-line-bot-release-probe") definition.env.push({ name: "DEEPSEEK_API_KEY", secretRef: "forbidden" });
  if (scenario === "periodic_args_mismatch" && name === "hhc-line-bot-periodic-assurance") definition.args = ["dist/tools/wrong.js"];
  if (scenario === "periodic_env_mismatch" && name === "hhc-line-bot-periodic-assurance") definition.env = definition.env.filter((entry) => entry.name !== "ASSET_API_URL");
  if (scenario === "periodic_resources_mismatch" && name === "hhc-line-bot-periodic-assurance") definition.resources.memory = "1Gi";
  if (scenario === "periodic_mount_mismatch" && name === "hhc-line-bot-periodic-assurance") definition.volumes.push({ name: "unexpected" });
  if (scenario === "periodic_provider_env" && name === "hhc-line-bot-periodic-assurance") definition.env.push({ name: "AZURE_OPENAI_EMBEDDING_API_KEY", secretRef: "forbidden" });
  output(definition);
  process.exit(0);
}

if (command("containerapp", "job", "start")) {
  if (name !== "hhc-line-bot-release-probe") process.exit(96);
  output("probe-exec-current");
  process.exit(0);
}

if (command("containerapp", "job", "logs", "show")) {
  if (name !== "hhc-line-bot-release-probe") process.exit(102);
  if (scenario === "release_probe_replica_gone") process.exit(44);
  const checks = [
    { name: "bot_health", status: scenario === "release_probe_child_failure" ? "failed" : "passed", code: scenario === "release_probe_child_failure" ? "http_mismatch" : "none" },
    { name: "bot_readiness", status: "passed", code: "none" },
    { name: "searxng_root", status: "passed", code: "none" },
    { name: "gateway_helper_signed_empty_webhook", status: "passed", code: "none" },
    { name: "gateway_main_signed_empty_webhook", status: "passed", code: "none" }
  ];
  const payload = {
    status: scenario === "release_probe_child_failure" ? "failed" : "passed",
    checks
  };
  if (scenario === "release_probe_logs_missing") output([]);
  else if (scenario === "release_probe_logs_malformed") output([{ Log: "{bad" }]);
  else if (scenario === "release_probe_logs_multiple") {
    output([{ Log: JSON.stringify(payload) }, { Log: JSON.stringify(payload) }]);
  } else output([{ Log: JSON.stringify(payload) }]);
  process.exit(0);
}

if (command("containerapp", "env", "show")) {
  if (name !== "fixture-env") process.exit(107);
  output("fixture-workspace");
  process.exit(0);
}

if (command("monitor", "log-analytics", "query")) {
  if (value("--workspace") !== "fixture-workspace") process.exit(108);
  if (scenario === "release_probe_logs_malformed") {
    output([{ Log_s: "{" }]);
    process.exit(0);
  }
  const checks = [
    {
      name: "bot_health",
      status: scenario === "release_probe_child_failure" ? "failed" : "passed",
      code:
        scenario === "release_probe_child_failure" ? "http_mismatch" : "none"
    },
    { name: "bot_readiness", status: "passed", code: "none" },
    { name: "searxng_root", status: "passed", code: "none" },
    { name: "gateway_helper_signed_empty_webhook", status: "passed", code: "none" },
    { name: "gateway_main_signed_empty_webhook", status: "passed", code: "none" }
  ];
  const payload = {
    status: scenario === "release_probe_child_failure" ? "failed" : "passed",
    checks
  };
  output(
    scenario === "release_probe_logs_multiple"
      ? [{ Log_s: JSON.stringify(payload) }, { Log_s: JSON.stringify(payload) }]
      : [{ Log_s: JSON.stringify(payload) }]
  );
  process.exit(0);
}

if (command("containerapp", "job", "execution", "show")) {
  const execution = value("--job-execution-name");
  if (name === "hhc-line-bot-release-probe" && execution === "probe-exec-current") {
    output(
      scenario === "release_probe_failure" ||
      scenario === "release_probe_child_failure" ||
      scenario === "known_good_tag" ||
      scenario === "job_restore_definition_mismatch" ||
      scenario === "worker_restore_definition_mismatch" ||
      scenario === "job_restore_image_mismatch" ||
      scenario === "searxng_restore" ||
      scenario === "searxng_restore_noop" ||
      scenario === "searxng_restore_contract_mismatch" ||
      scenario === "absent_assurance_jobs"
        ? "Failed"
        : "Succeeded"
    );
  } else if (
    name === "hhc-line-bot-attachment-worker" &&
    execution === "attachment-exec-current"
  ) {
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
  if (name === "fixture-searxng") {
    output("fixture-searxng");
    process.exit(0);
  }
  if (scenario === "rollback_copy_failure") process.exit(73);
  writeFileSync(path.join(state, "rollback"), "1");
  output("fixture-bot");
  process.exit(0);
}

if (command("containerapp", "job", "update")) {
  if (!oldImages[name]) process.exit(99);
  if (!args.includes("--yaml")) process.exit(99);
  writeFileSync(path.join(state, "restored-" + name), "1");
  process.exit(0);
}

if (command("containerapp", "job", "delete")) {
  if (
    scenario !== "absent_assurance_jobs" ||
    !["hhc-line-bot-release-probe", "hhc-line-bot-periodic-assurance"].includes(name)
  ) process.exit(103);
  process.exit(0);
}

process.stderr.write("Unexpected fake az call: " + args.join(" ") + "\\n");
process.exit(100);
`;
