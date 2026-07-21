import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { KernelGateReport } from "../evals/kernel/contracts.js";
import {
  assertKernelReportSafe,
  renderKernelReportMarkdown,
  writeKernelReport
} from "../evals/kernel/report.js";

const report: KernelGateReport = {
  schemaVersion: 1,
  generatedAt: "2026-07-21T00:00:00.000Z",
  passed: false,
  totalCases: 2,
  failedCaseIds: ["kernel-v1/resource/failure@1"],
  metrics: Object.fromEntries(
    [
      "schedule_accuracy",
      "core_journey_success",
      "unavailable_misclassification",
      "ambiguity_resolution",
      "security_violations",
      "core_read_completion",
      "recurrence_coverage"
    ].map((name) => [
      name,
      {
        numerator: 1,
        denominator: 2,
        value: 0.5,
        threshold: ">= 0.80",
        passed: false,
        failedCaseIds: ["kernel-v1/resource/failure@1"]
      }
    ])
  ) as KernelGateReport["metrics"],
  boundaryFailures: { adapter_retrieval: ["kernel-v1/resource/failure@1"] }
};

describe("Kernel v1 redacted reports", () => {
  it("renders only allowlisted metric and failure metadata", async () => {
    const markdown = renderKernelReportMarkdown(report);
    expect(markdown).toContain("schedule_accuracy");
    expect(markdown).toContain("kernel-v1/resource/failure@1");
    expect(() => assertKernelReportSafe(JSON.stringify(report))).not.toThrow();
    expect(() =>
      assertKernelReportSafe(JSON.stringify({ ...report, queryText: "private" }))
    ).toThrow("kernel_report_contains_forbidden_data");
    await expect(
      writeKernelReport(
        { ...report, failedCaseIds: ["kernel-v1/resource/U1234567890abcdef@1"] },
        "unused"
      )
    ).rejects.toThrow("kernel_report_contains_forbidden_data");
  });

  it("writes deterministic JSON and Markdown artifact names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kernel-report-"));
    try {
      await writeKernelReport(report, directory);
      const json = await readFile(join(directory, "report.json"), "utf8");
      const markdown = await readFile(join(directory, "report.md"), "utf8");
      expect(JSON.parse(json)).toEqual(report);
      expect(markdown).toBe(renderKernelReportMarkdown(report));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
