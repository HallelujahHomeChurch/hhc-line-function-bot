import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { KernelIntegrationCaseResult } from "./redis-matrix.js";

export const KERNEL_INTEGRATION_CASE_CONTRACTS = [
  { caseId: "redis/selection/atomic-consume", boundary: "slot_ambiguity_resolution" },
  { caseId: "redis/task-frame/requester-restart", boundary: "active_task_lifecycle" },
  { caseId: "redis/job/scope-restart", boundary: "external_dependency" },
  { caseId: "redis/webhook/cross-replica-deduplication", boundary: "entrance_access" },
  { caseId: "redis/in-flight/cross-replica-lock", boundary: "external_dependency" },
  { caseId: "redis/cache/cross-replica-invalidation", boundary: "freshness_invalidation" },
  { caseId: "redis/confirmation/actor-safe-consume", boundary: "write_workflow" },
  { caseId: "redis/session/group-requester-isolation", boundary: "slot_ambiguity_resolution" },
  { caseId: "redis/session/atomic-interactive-replacement", boundary: "active_task_lifecycle" },
  { caseId: "redis/restart/aof-policy", boundary: "deployment_configuration" },
  { caseId: "redis/restart/task-frame-durable", boundary: "active_task_lifecycle" },
  { caseId: "redis/restart/job-durable", boundary: "external_dependency" },
  { caseId: "redis/restart/webhook-durable", boundary: "entrance_access" },
  { caseId: "redis/restart/cache-durable", boundary: "freshness_invalidation" },
  { caseId: "redis/restart/selection-one-shot", boundary: "slot_ambiguity_resolution" },
  { caseId: "redis/restart/confirmation-one-shot", boundary: "write_workflow" },
  { caseId: "postgres/migrations/fresh-idempotent", boundary: "deployment_configuration" },
  { caseId: "postgres/catalog/concurrent-publication", boundary: "freshness_invalidation" },
  { caseId: "postgres/catalog/rollback-and-visibility", boundary: "adapter_retrieval" },
  { caseId: "postgres/knowledge/rollback-and-stale-failure", boundary: "adapter_retrieval" },
  { caseId: "harness/namespace-cleanup", boundary: "deployment_configuration" },
  { caseId: "harness/compose-cleanup", boundary: "deployment_configuration" }
] as const;

const stableCaseIds = new Set<string>(
  KERNEL_INTEGRATION_CASE_CONTRACTS.map(({ caseId }) => caseId)
);
const stableCaseBoundaries = new Map<string, string>(
  KERNEL_INTEGRATION_CASE_CONTRACTS.map(({ caseId, boundary }) => [caseId, boundary])
);

const boundaries = [
  "entrance_access",
  "candidate_generation",
  "planner_proposal",
  "deterministic_validation",
  "slot_ambiguity_resolution",
  "active_task_lifecycle",
  "adapter_retrieval",
  "freshness_invalidation",
  "result_envelope",
  "response_projection",
  "write_workflow",
  "external_dependency",
  "deployment_configuration"
] as const;

const versionSchema = z.string().regex(/^\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.]+)?$/i);
const failureCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
const resultSchema = z
  .object({
    caseId: z.string().refine((caseId) => stableCaseIds.has(caseId), {
      message: "unknown_case_id"
    }),
    boundary: z.enum(boundaries),
    passed: z.boolean(),
    failureCode: failureCodeSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.passed && result.failureCode) {
      context.addIssue({ code: "custom", message: "passed_case_has_failure_code" });
    }
    if (!result.passed && !result.failureCode) {
      context.addIssue({ code: "custom", message: "failed_case_requires_failure_code" });
    }
  });

const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    passed: z.boolean(),
    dependencyVersions: z
      .object({
        redis: versionSchema,
        postgres: versionSchema,
        pgvector: versionSchema
      })
      .strict(),
    results: z.array(resultSchema).min(1)
  })
  .strict()
  .superRefine((report, context) => {
    if (report.passed !== report.results.every((result) => result.passed)) {
      context.addIssue({ code: "custom", message: "report_pass_mismatch" });
    }
    const ids = report.results.map((result) => result.caseId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "duplicate_case_id" });
    }
    if (
      ids.length !== KERNEL_INTEGRATION_CASE_CONTRACTS.length ||
      KERNEL_INTEGRATION_CASE_CONTRACTS.some(({ caseId }) => !ids.includes(caseId))
    ) {
      context.addIssue({ code: "custom", message: "incomplete_case_set" });
    }
    for (const result of report.results) {
      if (stableCaseBoundaries.get(result.caseId) !== result.boundary) {
        context.addIssue({ code: "custom", message: "case_boundary_mismatch" });
      }
    }
  });

export type KernelIntegrationReport = z.infer<typeof reportSchema>;

export function createKernelIntegrationReport(input: {
  generatedAt: string;
  dependencyVersions: KernelIntegrationReport["dependencyVersions"];
  results: KernelIntegrationCaseResult[];
}): KernelIntegrationReport {
  return reportSchema.parse({
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    passed: input.results.every((result) => result.passed),
    dependencyVersions: input.dependencyVersions,
    results: input.results
  });
}

export function serializeKernelIntegrationReport(report: unknown): string {
  return `${JSON.stringify(reportSchema.parse(report), null, 2)}\n`;
}

export async function writeKernelIntegrationReport(
  report: KernelIntegrationReport,
  path = "artifacts/kernel-v1/integration-report.json"
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeKernelIntegrationReport(report), "utf8");
}
