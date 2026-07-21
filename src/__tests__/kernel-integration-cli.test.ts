import { describe, expect, it, vi } from "vitest";

import {
  KERNEL_INTEGRATION_CASE_CONTRACTS,
  createKernelIntegrationReport,
  serializeKernelIntegrationReport
} from "../evals/kernel/integration/report.js";
import { verifyRedisAofPolicy } from "../evals/kernel/integration/redis-matrix.js";
import { resolveKernelWorkerExit } from "../tools/eval-kernel-integration.js";

function completeResults() {
  return KERNEL_INTEGRATION_CASE_CONTRACTS.map(({ caseId, boundary }) => ({
    caseId,
    boundary,
    passed: true as const
  }));
}

describe("Kernel v1 integration report", () => {
  it("serializes only the privacy-allowlisted contract", () => {
    const report = createKernelIntegrationReport({
      generatedAt: "2026-07-21T00:00:00.000Z",
      dependencyVersions: {
        redis: "7.4.2",
        postgres: "16.10",
        pgvector: "0.8.1"
      },
      results: completeResults()
    });

    expect(JSON.parse(serializeKernelIntegrationReport(report))).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-07-21T00:00:00.000Z",
      passed: true,
      dependencyVersions: {
        redis: "7.4.2",
        postgres: "16.10",
        pgvector: "0.8.1"
      },
      results: completeResults()
    });
  });

  it("rejects a report that omits any stable integration case", () => {
    const results = completeResults();
    results.pop();
    expect(() =>
      createKernelIntegrationReport({
        generatedAt: "2026-07-21T00:00:00.000Z",
        dependencyVersions: { redis: "7.4.2", postgres: "16.10", pgvector: "0.8.1" },
        results
      })
    ).toThrow();
  });

  it("rejects unexpected fields and unbounded identifiers before serialization", () => {
    const valid = {
      schemaVersion: 1,
      generatedAt: "2026-07-21T00:00:00.000Z",
      passed: false,
      dependencyVersions: {
        redis: "7.4.2",
        postgres: "16.10",
        pgvector: "0.8.1"
      },
      results: completeResults().map((result, index) =>
        index === 0 ? { ...result, passed: false, failureCode: "redis_contract_failed" } : result
      )
    };

    expect(() =>
      serializeKernelIntegrationReport({ ...valid, redisUrl: "redis://secret" })
    ).toThrow();
    expect(() =>
      serializeKernelIntegrationReport({
        ...valid,
        results: [{ ...valid.results[0], filename: "private.pdf" }, ...valid.results.slice(1)]
      })
    ).toThrow();
    expect(() =>
      serializeKernelIntegrationReport({
        ...valid,
        results: [{ ...valid.results[0], caseId: "user supplied title" }, ...valid.results.slice(1)]
      })
    ).toThrow();
    expect(() =>
      serializeKernelIntegrationReport({
        ...valid,
        results: [
          { ...valid.results[0], failureCode: "database at postgres://secret" },
          ...valid.results.slice(1)
        ]
      })
    ).toThrow();
  });

  it("preserves a completed worker failure result for reporting and exit code 1", () => {
    const results = completeResults()
      .slice(0, -1)
      .map((result, index) =>
        index === 0 ? { ...result, passed: false, failureCode: "redis_contract_failed" } : result
      );
    const message = {
      type: "success" as const,
      dependencyVersions: { redis: "7.4.2", postgres: "16.10", pgvector: "0.8.1" },
      results
    };

    expect(resolveKernelWorkerExit(message, 1)).toBe(message);
  });

  it("checks the live Redis AOF policy before restart", async () => {
    const configGet = vi.fn().mockResolvedValue({ appendonly: "yes", appendfsync: "always" });
    await expect(verifyRedisAofPolicy({ configGet })).resolves.toEqual({
      caseId: "redis/restart/aof-policy",
      boundary: "deployment_configuration",
      passed: true
    });
    expect(configGet).toHaveBeenCalledWith(["appendonly", "appendfsync"]);

    configGet.mockResolvedValueOnce({ appendonly: "no", appendfsync: "everysec" });
    await expect(verifyRedisAofPolicy({ configGet })).resolves.toEqual({
      caseId: "redis/restart/aof-policy",
      boundary: "deployment_configuration",
      passed: false,
      failureCode: "redis_aof_policy_invalid"
    });
  });
});
