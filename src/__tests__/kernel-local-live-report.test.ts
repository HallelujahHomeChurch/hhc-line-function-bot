import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoSecretBytes,
  createKernelLocalLiveReport,
  writeKernelLocalLiveReport
} from "../evals/kernel/local-live/report.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Kernel local live report", () => {
  it("rejects unknown report input fields instead of serializing raw data", () => {
    expect(() =>
      createKernelLocalLiveReport({
        ...validReportInput(),
        rawMessage: "synthetic private input"
      })
    ).toThrow("kernel_local_live_report_unknown_key");
  });

  it("writes only the allowlisted JSON and Markdown evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kernel-local-live-report-"));
    temporaryDirectories.push(root);
    const report = createKernelLocalLiveReport(validReportInput());

    await writeKernelLocalLiveReport(report, root);

    const json = await readFile(
      path.join(root, "artifacts/kernel-v1/local-live-report.json"),
      "utf8"
    );
    const markdown = await readFile(
      path.join(root, "artifacts/kernel-v1/local-live-report.md"),
      "utf8"
    );
    expect(JSON.parse(json)).toEqual(report);
    expect(markdown).toContain("cases: 1/1");
    expect(markdown).toContain("DeepSeek requests: 1/10");
    expect(markdown).not.toContain("synthetic private input");
  });

  it("detects secret bytes without reflecting them in the error", () => {
    const secret = Buffer.from("live-provider-secret");
    expect(() =>
      assertNoSecretBytes(
        [Buffer.from("safe"), Buffer.from("prefix-live-provider-secret-suffix")],
        [secret]
      )
    ).toThrow("kernel_local_live_secret_leak_detected");

    try {
      assertNoSecretBytes([Buffer.from("live-provider-secret")], [secret]);
    } catch (error) {
      expect(String(error)).not.toContain(secret.toString("utf8"));
    }
  });
});

function validReportInput(): Record<string, unknown> {
  return {
    startedAt: "2026-07-26T00:00:00.000Z",
    completedAt: "2026-07-26T00:01:00.000Z",
    commit: "0123456789abcdef0123456789abcdef01234567",
    selectedCaseIds: ["schedule-explicit"],
    passed: true,
    cases: [
      {
        caseId: "schedule-explicit",
        passed: true,
        disposition: "execute",
        capability: "query_schedule",
        validatorReason: "deterministic_explicit_intent",
        resultClass: "success",
        lifecycleOutcome: "write"
      }
    ],
    providers: {
      deepSeekRequests: 1,
      embeddingBatches: 0
    },
    cleanup: {
      namespace: true,
      compose: true,
      secretFiles: true,
      passed: true
    }
  };
}
