import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { KERNEL_LOCAL_LIVE_CASE_IDS, type KernelLocalLiveCaseId } from "./contracts.js";

const ROOT_KEYS = new Set([
  "startedAt",
  "completedAt",
  "commit",
  "selectedCaseIds",
  "passed",
  "cases",
  "providers",
  "cleanup"
]);
const CASE_KEYS = new Set([
  "caseId",
  "passed",
  "failureCode",
  "disposition",
  "capability",
  "validatorReason",
  "resultClass",
  "lifecycleOutcome"
]);
const PROVIDER_KEYS = new Set(["deepSeekRequests", "embeddingBatches"]);
const CLEANUP_KEYS = new Set(["namespace", "compose", "secretFiles", "passed"]);

export interface KernelLocalLiveCaseReport {
  caseId: KernelLocalLiveCaseId;
  passed: boolean;
  failureCode?: string;
  disposition?: string;
  capability?: string;
  validatorReason?: string;
  resultClass?: string;
  lifecycleOutcome?: string;
}

export interface KernelLocalLiveReport {
  schemaVersion: 1;
  caseSetVersion: 1;
  startedAt: string;
  completedAt: string;
  commit: string;
  selectedCaseIds: KernelLocalLiveCaseId[];
  passed: boolean;
  cases: KernelLocalLiveCaseReport[];
  providers: {
    deepSeekRequests: number;
    embeddingBatches: number;
  };
  cleanup: {
    namespace: boolean;
    compose: boolean;
    secretFiles: boolean;
    passed: boolean;
  };
}

export function createKernelLocalLiveReport(input: unknown): KernelLocalLiveReport {
  const value = record(input);
  assertExactKeys(value, ROOT_KEYS);
  const selectedCaseIds = stringArray(value.selectedCaseIds).map(assertCaseId);
  const cases = array(value.cases).map((entry) => {
    const item = record(entry);
    assertExactKeys(item, CASE_KEYS);
    return {
      caseId: assertCaseId(string(item.caseId)),
      passed: boolean(item.passed),
      ...optionalStringFields(item, [
        "failureCode",
        "disposition",
        "capability",
        "validatorReason",
        "resultClass",
        "lifecycleOutcome"
      ])
    };
  });
  const providers = record(value.providers);
  assertExactKeys(providers, PROVIDER_KEYS);
  const cleanup = record(value.cleanup);
  assertExactKeys(cleanup, CLEANUP_KEYS);

  return {
    schemaVersion: 1,
    caseSetVersion: 1,
    startedAt: isoTimestamp(value.startedAt),
    completedAt: isoTimestamp(value.completedAt),
    commit: commit(value.commit),
    selectedCaseIds,
    passed: boolean(value.passed),
    cases,
    providers: {
      deepSeekRequests: nonNegativeInteger(providers.deepSeekRequests),
      embeddingBatches: nonNegativeInteger(providers.embeddingBatches)
    },
    cleanup: {
      namespace: boolean(cleanup.namespace),
      compose: boolean(cleanup.compose),
      secretFiles: boolean(cleanup.secretFiles),
      passed: boolean(cleanup.passed)
    }
  };
}

export async function writeKernelLocalLiveReport(
  report: KernelLocalLiveReport,
  rootDir: string
): Promise<void> {
  const outputDirectory = path.join(rootDir, "artifacts/kernel-v1");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "local-live-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  const passedCases = report.cases.filter(({ passed }) => passed).length;
  const markdown = [
    "# Kernel v1 Local Live Report",
    "",
    `result: ${report.passed ? "PASS" : "FAIL"}`,
    `cases: ${passedCases}/${report.cases.length}`,
    `DeepSeek requests: ${report.providers.deepSeekRequests}/10`,
    `Embedding batches: ${report.providers.embeddingBatches}/3`,
    `cleanup: ${report.cleanup.passed ? "PASS" : "FAIL"}`,
    ""
  ].join("\n");
  await writeFile(path.join(outputDirectory, "local-live-report.md"), markdown, {
    encoding: "utf8",
    mode: 0o600
  });
}

export function assertNoSecretBytes(
  buffers: readonly Buffer[],
  secretBytes: readonly Buffer[]
): void {
  for (const secret of secretBytes) {
    if (secret.length === 0) throw new Error("kernel_local_live_secret_empty");
    if (buffers.some((buffer) => buffer.includes(secret))) {
      throw new Error("kernel_local_live_secret_leak_detected");
    }
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("kernel_local_live_report_unknown_key");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("kernel_local_live_report_invalid");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("kernel_local_live_report_invalid");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("kernel_local_live_report_invalid");
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return array(value).map(string);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("kernel_local_live_report_invalid");
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("kernel_local_live_report_invalid");
  }
  return value;
}

function isoTimestamp(value: unknown): string {
  const candidate = string(value);
  if (new Date(candidate).toISOString() !== candidate) {
    throw new Error("kernel_local_live_report_invalid");
  }
  return candidate;
}

function commit(value: unknown): string {
  const candidate = string(value);
  if (!/^[a-f0-9]{40}$/u.test(candidate)) throw new Error("kernel_local_live_report_invalid");
  return candidate;
}

function assertCaseId(value: string): KernelLocalLiveCaseId {
  if (!KERNEL_LOCAL_LIVE_CASE_IDS.includes(value as KernelLocalLiveCaseId)) {
    throw new Error("kernel_local_live_report_invalid");
  }
  return value as KernelLocalLiveCaseId;
}

function optionalStringFields(
  value: Record<string, unknown>,
  keys: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, string(value[key])]]))
  );
}
