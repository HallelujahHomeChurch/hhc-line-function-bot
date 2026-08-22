export type AssuranceReportKind = "release" | "periodic";
export type AssuranceReportStatus = "passed" | "failed";
export type AssuranceCheckStatus = "passed" | "failed" | "warning";
export type AssuranceRollbackStatus = "not_required" | "restored" | "failed";
export type AssuranceFailureCode =
  | "none"
  | "bot_health_failed"
  | "bot_readiness_failed"
  | "searxng_root_failed"
  | "gateway_webhook_failed"
  | "graph_metadata_failed"
  | "notion_query_failed"
  | "attachment_queue_failed"
  | "diagnostic_folder_failed"
  | "diagnostic_upload_failed"
  | "diagnostic_delete_failed"
  | "asset_lifecycle_failed"
  | "asset_cleanup_failed"
  | "network_failed"
  | "timeout"
  | "http_mismatch"
  | "malformed_json"
  | "rollback_failed";
export type AssuranceResourceName =
  "bot" | "searxng" | "catalog_sync" | "attachment_worker" | "release_probe" | "periodic_assurance";
export type ReleaseCheckName =
  | "target_revision"
  | "target_traffic"
  | "bot_ingress"
  | "bot_dapr"
  | "account_preflight"
  | "searxng_deployment"
  | "release_probe"
  | "catalog_job"
  | "attachment_worker_job"
  | "periodic_assurance_job"
  | "bot_health"
  | "bot_readiness"
  | "searxng_root"
  | "gateway_helper_signed_empty_webhook"
  | "gateway_main_signed_empty_webhook";
export type PeriodicCheckName =
  | "graph_metadata"
  | "notion_query"
  | "attachment_queue"
  | "diagnostic_write_delete"
  | "asset_lifecycle";
export type AssuranceCheckName = ReleaseCheckName | PeriodicCheckName;

export interface AssuranceCheck {
  name: AssuranceCheckName;
  status: AssuranceCheckStatus;
  observedAt: string;
  code: AssuranceFailureCode | "signature_warning";
}

export interface AssuranceReportTarget {
  resource: AssuranceResourceName;
  revision: string;
  image: string;
  status: "ready" | "failed";
}

export interface AssuranceKnownGood {
  revision: string;
  image: string;
}

export interface AssuranceReportInput {
  version: 1;
  kind: AssuranceReportKind;
  releaseId: string;
  commitSha: string;
  startedAt: string;
  completedAt: string;
  status: AssuranceReportStatus;
  failureCode: AssuranceFailureCode;
  target: AssuranceReportTarget;
  knownGood: AssuranceKnownGood;
  checks: AssuranceCheck[];
  rollback: { status: AssuranceRollbackStatus; revision?: string; image?: string };
  providerRequests?: { deepseek: 0; embedding: 0 };
}

export type AssuranceReport = AssuranceReportInput;

const failureCodes = new Set<AssuranceFailureCode>([
  "none",
  "bot_health_failed",
  "bot_readiness_failed",
  "searxng_root_failed",
  "gateway_webhook_failed",
  "graph_metadata_failed",
  "notion_query_failed",
  "attachment_queue_failed",
  "diagnostic_folder_failed",
  "diagnostic_upload_failed",
  "diagnostic_delete_failed",
  "asset_lifecycle_failed",
  "asset_cleanup_failed",
  "network_failed",
  "timeout",
  "http_mismatch",
  "malformed_json",
  "rollback_failed"
]);
const resources = new Set<AssuranceResourceName>([
  "bot",
  "searxng",
  "catalog_sync",
  "attachment_worker",
  "release_probe",
  "periodic_assurance"
]);
const releaseChecks = new Set<ReleaseCheckName>([
  "target_revision",
  "target_traffic",
  "bot_ingress",
  "bot_dapr",
  "account_preflight",
  "searxng_deployment",
  "release_probe",
  "catalog_job",
  "attachment_worker_job",
  "periodic_assurance_job",
  "bot_health",
  "bot_readiness",
  "searxng_root",
  "gateway_helper_signed_empty_webhook",
  "gateway_main_signed_empty_webhook"
]);
const periodicChecks = new Set<PeriodicCheckName>([
  "graph_metadata",
  "notion_query",
  "attachment_queue",
  "diagnostic_write_delete",
  "asset_lifecycle"
]);

export function buildAssuranceReport(input: AssuranceReportInput): AssuranceReport {
  const value = input as unknown;
  assertObject(
    value,
    [
      "version",
      "kind",
      "releaseId",
      "commitSha",
      "startedAt",
      "completedAt",
      "status",
      "failureCode",
      "target",
      "knownGood",
      "checks",
      "rollback",
      "providerRequests"
    ],
    [
      "version",
      "kind",
      "releaseId",
      "commitSha",
      "startedAt",
      "completedAt",
      "status",
      "failureCode",
      "target",
      "knownGood",
      "checks",
      "rollback"
    ]
  );
  const source = value as Record<string, unknown>;
  const kind = enumValue(source.kind, ["release", "periodic"] as const);
  const status = enumValue(source.status, ["passed", "failed"] as const);
  const failureCode = failureCodeValue(source.failureCode);
  const startedAt = isoTimestamp(source.startedAt);
  const completedAt = isoTimestamp(source.completedAt);
  const reportChecks = checks(source.checks, kind);
  const reportCheckNames = new Set(reportChecks.map((check) => check.name));
  const providerRequestReport =
    source.providerRequests === undefined ? undefined : providerRequests(source.providerRequests);
  const report: AssuranceReport = {
    version: exactOne(source.version),
    kind,
    releaseId: safeIdentifier(source.releaseId),
    commitSha: commitSha(source.commitSha),
    startedAt,
    completedAt,
    status,
    failureCode,
    target: target(source.target),
    knownGood: knownGood(source.knownGood),
    checks: reportChecks,
    rollback: rollback(source.rollback),
    ...(providerRequestReport === undefined ? {} : { providerRequests: providerRequestReport })
  };
  if ((kind === "periodic" || status === "passed") && providerRequestReport === undefined)
    invalid();
  if (reportCheckNames.size !== reportChecks.length) invalid();
  if (
    kind === "release" &&
    status === "passed" &&
    (["gateway_helper_signed_empty_webhook", "gateway_main_signed_empty_webhook"] as const).some(
      (name) => !reportCheckNames.has(name)
    )
  ) {
    invalid();
  }
  if ((status === "passed") !== (failureCode === "none")) invalid();
  if (status === "passed" && reportChecks.some((check) => check.status === "failed")) invalid();
  if (Date.parse(completedAt) < Date.parse(startedAt)) invalid();
  return report;
}

function checks(value: unknown, kind: AssuranceReportKind): AssuranceCheck[] {
  if (!Array.isArray(value)) invalid();
  return value.map((item) => {
    assertObject(item, ["name", "status", "observedAt", "code"]);
    const source = item as Record<string, unknown>;
    const name = checkName(source.name, kind);
    const status = enumValue(source.status, ["passed", "failed", "warning"] as const);
    const code = checkCode(source.code);
    if ((status === "warning") !== (code === "signature_warning")) invalid();
    if (status === "passed" && code !== "none") invalid();
    if (status === "failed" && code === "none") invalid();
    return { name, status, observedAt: isoTimestamp(source.observedAt), code };
  });
}

function target(value: unknown): AssuranceReportTarget {
  assertObject(value, ["resource", "revision", "image", "status"]);
  const source = value as Record<string, unknown>;
  return {
    resource: resource(source.resource),
    revision: safeIdentifier(source.revision),
    image: immutableImage(source.image),
    status: enumValue(source.status, ["ready", "failed"] as const)
  };
}

function knownGood(value: unknown): AssuranceKnownGood {
  assertObject(value, ["revision", "image"]);
  const source = value as Record<string, unknown>;
  return { revision: safeIdentifier(source.revision), image: immutableImage(source.image) };
}

function rollback(value: unknown): AssuranceReport["rollback"] {
  assertObject(value, ["status", "revision", "image"], ["status"]);
  const source = value as Record<string, unknown>;
  const status = enumValue(source.status, ["not_required", "restored", "failed"] as const);
  const revision = source.revision === undefined ? undefined : safeIdentifier(source.revision);
  const image = source.image === undefined ? undefined : immutableImage(source.image);
  if ((revision === undefined) !== (image === undefined)) invalid();
  if (status === "not_required" && revision !== undefined) invalid();
  if (status === "restored" && revision === undefined) invalid();
  return {
    status,
    ...(revision === undefined ? {} : { revision }),
    ...(image === undefined ? {} : { image })
  };
}

function providerRequests(value: unknown): AssuranceReport["providerRequests"] {
  assertObject(value, ["deepseek", "embedding"]);
  const source = value as Record<string, unknown>;
  if (source.deepseek !== 0 || source.embedding !== 0) invalid();
  return { deepseek: 0, embedding: 0 };
}

function checkName(value: unknown, kind: AssuranceReportKind): AssuranceCheckName {
  if (typeof value !== "string") invalid();
  const allowed = kind === "release" ? releaseChecks : periodicChecks;
  if (!allowed.has(value as never)) invalid();
  return value as AssuranceCheckName;
}

function checkCode(value: unknown): AssuranceCheck["code"] {
  if (value === "signature_warning") return value;
  return failureCodeValue(value);
}

function failureCodeValue(value: unknown): AssuranceFailureCode {
  if (typeof value !== "string" || !failureCodes.has(value as AssuranceFailureCode)) invalid();
  return value as AssuranceFailureCode;
}

function resource(value: unknown): AssuranceResourceName {
  if (typeof value !== "string" || !resources.has(value as AssuranceResourceName)) invalid();
  return value as AssuranceResourceName;
}

function exactOne(value: unknown): 1 {
  if (value !== 1) invalid();
  return 1;
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== "string") invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid();
  return value;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) invalid();
  return value;
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) invalid();
  return value;
}

function immutableImage(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    invalid();
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid();
  return value as T[number];
}

function assertObject(
  value: unknown,
  keys: string[],
  required = keys
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
  if (required.some((key) => !(key in value))) invalid();
}

function invalid(): never {
  throw new Error("assurance_report_invalid");
}
