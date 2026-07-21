import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { KernelGateReport } from "./contracts.js";

const forbiddenReportData =
  /https?:\/\/|"(?:queryText|sourceTitle|fileName|personValue|providerPayload|replyToken|token|secret)"/iu;

export function assertKernelReportSafe(serialized: string): void {
  if (forbiddenReportData.test(serialized)) {
    throw new Error("kernel_report_contains_forbidden_data");
  }
}

export function renderKernelReportMarkdown(report: KernelGateReport): string {
  const lines = [
    "# Kernel v1 Acceptance Report",
    "",
    `- Schema: ${report.schemaVersion}`,
    `- Generated: ${report.generatedAt}`,
    `- Result: ${report.passed ? "PASS" : "FAIL"}`,
    `- Cases: ${report.totalCases}`,
    "",
    "## Metrics",
    "",
    "| Metric | Numerator | Denominator | Value | Threshold | Result |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...Object.entries(report.metrics).map(
      ([name, metric]) =>
        [
          `| ${name}`,
          metric.numerator,
          metric.denominator,
          metric.value === undefined ? "incomplete" : metric.value.toFixed(4),
          metric.threshold,
          metric.passed && !metric.incomplete ? "PASS" : "FAIL"
        ].join(" | ") + " |"
    ),
    "",
    "## Failed Cases",
    "",
    ...(report.failedCaseIds.length
      ? report.failedCaseIds.map((caseId) => `- ${caseId}`)
      : ["- none"]),
    "",
    "## Boundary Failures",
    "",
    ...(Object.keys(report.boundaryFailures).length
      ? Object.entries(report.boundaryFailures).map(
          ([boundary, caseIds]) => `- ${boundary}: ${(caseIds ?? []).join(", ")}`
        )
      : ["- none"]),
    ""
  ];
  const markdown = lines.join("\n");
  assertKernelReportSafe(markdown);
  return markdown;
}

export async function writeKernelReport(
  report: KernelGateReport,
  outputDirectory: string
): Promise<void> {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderKernelReportMarkdown(report);
  assertKernelReportSafe(json);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, "report.json"), json, "utf8"),
    writeFile(join(outputDirectory, "report.md"), markdown, "utf8")
  ]);
}
