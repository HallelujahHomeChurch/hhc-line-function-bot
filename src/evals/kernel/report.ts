import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { KernelGateReport, KernelMetricName } from "./contracts.js";

const forbiddenReportData =
  /https?:\/\/|\bU[0-9A-F]{16,}\b|\b[CG][0-9a-f]{16,}\b|"(?:queryText|sourceTitle|fileName|personValue|providerPayload|replyToken|token|secret)"/iu;
const caseIdPattern = /^kernel-v1\/[a-z_]+\/[a-z0-9-]+@1$/u;
const missingFamilyPattern = /^missing-family:[a-z_]+$/u;
const metricNames: KernelMetricName[] = [
  "schedule_accuracy",
  "core_journey_success",
  "unavailable_misclassification",
  "ambiguity_resolution",
  "security_violations",
  "core_read_completion",
  "recurrence_coverage"
];

export function assertKernelReportSafe(serialized: string): void {
  if (forbiddenReportData.test(serialized)) {
    throw new Error("kernel_report_contains_forbidden_data");
  }
}

export function renderKernelReportMarkdown(report: KernelGateReport): string {
  const safeReport = projectKernelReport(report);
  const lines = [
    "# Kernel v1 Acceptance Report",
    "",
    `- Schema: ${safeReport.schemaVersion}`,
    `- Generated: ${safeReport.generatedAt}`,
    `- Result: ${safeReport.passed ? "PASS" : "FAIL"}`,
    `- Cases: ${safeReport.totalCases}`,
    "",
    "## Metrics",
    "",
    "| Metric | Numerator | Denominator | Value | Threshold | Result |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...Object.entries(safeReport.metrics).map(
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
    ...(safeReport.failedCaseIds.length
      ? safeReport.failedCaseIds.map((caseId) => `- ${caseId}`)
      : ["- none"]),
    "",
    "## Boundary Failures",
    "",
    ...(Object.keys(safeReport.boundaryFailures).length
      ? Object.entries(safeReport.boundaryFailures).map(
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
  const safeReport = projectKernelReport(report);
  const json = `${JSON.stringify(safeReport, null, 2)}\n`;
  const markdown = renderKernelReportMarkdown(safeReport);
  assertKernelReportSafe(json);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, "report.json"), json, "utf8"),
    writeFile(join(outputDirectory, "report.md"), markdown, "utf8")
  ]);
}

function projectKernelReport(report: KernelGateReport): KernelGateReport {
  const failedCaseIds = report.failedCaseIds.map((caseId) => safeCaseId(caseId));
  const metrics = Object.fromEntries(
    metricNames.map((name) => {
      const metric = report.metrics[name];
      if (!metric) throw new Error("kernel_report_contains_forbidden_data");
      return [
        name,
        {
          numerator: finiteNumber(metric.numerator),
          denominator: finiteNumber(metric.denominator),
          ...(metric.value === undefined ? {} : { value: finiteNumber(metric.value) }),
          threshold: safeToken(metric.threshold),
          passed: metric.passed === true,
          ...(metric.incomplete === true ? { incomplete: true } : {}),
          failedCaseIds: metric.failedCaseIds.map((caseId) => safeCaseId(caseId, true))
        }
      ];
    })
  ) as KernelGateReport["metrics"];
  const boundaryFailures = Object.fromEntries(
    Object.entries(report.boundaryFailures).map(([boundary, caseIds]) => {
      if (!/^[a-z_]+$/u.test(boundary)) throw new Error("kernel_report_contains_forbidden_data");
      return [boundary, (caseIds ?? []).map((caseId) => safeCaseId(caseId))];
    })
  ) as KernelGateReport["boundaryFailures"];
  const projected: KernelGateReport = {
    schemaVersion: 1,
    generatedAt: safeIsoDate(report.generatedAt),
    passed: report.passed === true,
    totalCases: finiteNumber(report.totalCases),
    failedCaseIds,
    metrics,
    boundaryFailures
  };
  assertKernelReportSafe(JSON.stringify(projected));
  return projected;
}

function safeCaseId(value: string, allowMissingFamily = false): string {
  if (!caseIdPattern.test(value) && !(allowMissingFamily && missingFamilyPattern.test(value))) {
    throw new Error("kernel_report_contains_forbidden_data");
  }
  return value;
}

function finiteNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("kernel_report_contains_forbidden_data");
  return value;
}

function safeToken(value: string): string {
  if (!/^[<>= 0-9.]+$/u.test(value)) throw new Error("kernel_report_contains_forbidden_data");
  return value;
}

function safeIsoDate(value: string): string {
  if (Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    throw new Error("kernel_report_contains_forbidden_data");
  }
  return value;
}
