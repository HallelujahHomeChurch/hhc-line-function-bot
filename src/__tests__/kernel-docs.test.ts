import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const files = [
  "README.md",
  "AGENTS.md",
  "docs/operations/controlled-agent-support.md",
  "docs/kernel-v1/acceptance-baseline.md"
];

describe("Kernel v1 operating documentation", () => {
  it("documents the deterministic command, artifacts, metrics, and boundary-first triage", () => {
    const content = files.map((file) => readFileSync(resolve(file), "utf8")).join("\n");

    expect(content).toContain("pnpm eval:kernel");
    expect(content).toContain("pnpm eval:kernel:integration");
    expect(content).toContain("artifacts/kernel-v1/report.json");
    expect(content).toContain("artifacts/kernel-v1/integration-report.json");
    expect(content).toContain("single-process local development");
    expect(content).toContain("Redis server restart");
    expect(content).toContain("live-provider");
    expect(content).toContain("production observation");
    for (const metric of [
      "schedule_accuracy",
      "core_journey_success",
      "unavailable_misclassification",
      "ambiguity_resolution",
      "security_violations",
      "core_read_completion",
      "recurrence_coverage"
    ]) {
      expect(content).toContain(metric);
    }
    expect(content).toContain("case_execution_failed");
    expect(content).toContain("failed boundary ID");
    expect(content).toContain("不要依失敗語句加入特例");
  });
});
