import { posix } from "node:path";

import { assessClamAvSignatureManifest } from "../attachments/clamav-signature-policy.js";
import type { ClamAvCliScanResult } from "../attachments/clamav-cli.js";
import type { AssuranceCheck, AssuranceFailureCode } from "./report.js";
import type { AssetLifecycleAssuranceResult } from "./asset-lifecycle-probe.js";
import type { DriveItem } from "../types.js";

export type PeriodicAssuranceCheckName =
  | "graph_metadata"
  | "notion_query"
  | "attachment_queue"
  | "clamav_signature"
  | "clamav_clean"
  | "clamav_eicar"
  | "diagnostic_write_delete"
  | "asset_lifecycle";

export type PeriodicAssuranceFailureCode =
  | "none"
  | "graph_metadata_failed"
  | "notion_query_failed"
  | "attachment_queue_failed"
  | "clamav_manifest_invalid"
  | "clamav_clean_failed"
  | "clamav_eicar_failed"
  | "diagnostic_folder_failed"
  | "diagnostic_upload_failed"
  | "diagnostic_delete_failed"
  | "asset_lifecycle_failed"
  | "asset_cleanup_failed"
  | "timeout"
  | "signature_warning";

export interface PeriodicAssuranceInput {
  graphDriveId: string;
  graphOtherFolderItemId: string;
  notionDatabaseId: string;
  clamavSignatureManifestPath: string;
  scanTimeoutMs: number;
}

export interface PeriodicAssuranceDependencies {
  readGraphMetadata(driveId: string, itemId: string): Promise<DriveItem | undefined>;
  readNotionOne(databaseId: string, pageSize: 1): Promise<number>;
  inspectQueue(): Promise<{ depth: number; oldestInsertedAt?: Date }>;
  readSignatureManifest(path: string): Promise<unknown>;
  scanSample(input: {
    kind: "clean" | "eicar";
    fileName: string;
    data: Uint8Array;
    databaseDirectory: string;
    timeoutMs: number;
  }): Promise<ClamAvCliScanResult>;
  ensureDiagnosticsFolder(driveId: string, parentItemId: string, name: string): Promise<DriveItem>;
  uploadDiagnostic(
    driveId: string,
    parentItemId: string,
    fileName: string,
    data: Uint8Array,
    contentType: string
  ): Promise<DriveItem>;
  deleteDiagnostic(driveId: string, itemId: string): Promise<void>;
  runAssetLifecycle(): Promise<AssetLifecycleAssuranceResult>;
  now(): Date;
}

export interface PeriodicAssuranceCheckResult {
  name: PeriodicAssuranceCheckName;
  status: "passed" | "failed" | "warning";
  code: PeriodicAssuranceFailureCode;
}

export interface PeriodicAssuranceResult {
  status: "passed" | "failed";
  checks: PeriodicAssuranceCheckResult[];
  queue: { depth: number; oldestAgeSeconds: number | null };
  providerRequests: { deepseek: 0; embedding: 0 };
}

export function mapPeriodicAssuranceCodeToReport(
  code: PeriodicAssuranceFailureCode
): AssuranceCheck["code"] {
  if (code === "signature_warning") return code;
  return code satisfies AssuranceFailureCode;
}

const DIAGNOSTICS_FOLDER_NAME = "assurance-diagnostics";
const DIAGNOSTIC_FILE_NAME = "periodic-assurance.txt";
const CLEAN_FILE_NAME = "periodic-clean.txt";
const EICAR_FILE_NAME = "periodic-eicar.txt";
const CLEAN_PAYLOAD = new TextEncoder().encode("HHC periodic assurance\n");
const EICAR_PAYLOAD = new TextEncoder().encode(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
);

export async function runPeriodicAssurance(
  input: PeriodicAssuranceInput,
  dependencies: PeriodicAssuranceDependencies
): Promise<PeriodicAssuranceResult> {
  const checks: PeriodicAssuranceCheckResult[] = [];

  checks.push(await graphMetadataCheck(input, dependencies));
  checks.push(await notionCheck(input, dependencies));
  const queue = await queueCheck(dependencies);
  checks.push(queue.check);

  const clamav = await clamAvChecks(input, dependencies);
  checks.push(...clamav);
  checks.push(await diagnosticWriteDeleteCheck(input, dependencies));
  checks.push(await assetLifecycleCheck(dependencies));

  return {
    status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
    checks,
    queue: queue.observation,
    providerRequests: { deepseek: 0, embedding: 0 }
  };
}

async function assetLifecycleCheck(
  dependencies: PeriodicAssuranceDependencies
): Promise<PeriodicAssuranceCheckResult> {
  try {
    const result = await dependencies.runAssetLifecycle();
    return result.status === "passed"
      ? passed("asset_lifecycle")
      : { name: "asset_lifecycle", status: "failed", code: result.code };
  } catch {
    return failed("asset_lifecycle", "asset_lifecycle_failed");
  }
}

async function graphMetadataCheck(
  input: PeriodicAssuranceInput,
  dependencies: PeriodicAssuranceDependencies
): Promise<PeriodicAssuranceCheckResult> {
  try {
    const item = await dependencies.readGraphMetadata(
      input.graphDriveId,
      input.graphOtherFolderItemId
    );
    return item?.id ? passed("graph_metadata") : failed("graph_metadata", "graph_metadata_failed");
  } catch {
    return failed("graph_metadata", "graph_metadata_failed");
  }
}

async function notionCheck(
  input: PeriodicAssuranceInput,
  dependencies: PeriodicAssuranceDependencies
): Promise<PeriodicAssuranceCheckResult> {
  try {
    return (await dependencies.readNotionOne(input.notionDatabaseId, 1)) === 1
      ? passed("notion_query")
      : failed("notion_query", "notion_query_failed");
  } catch {
    return failed("notion_query", "notion_query_failed");
  }
}

async function queueCheck(dependencies: PeriodicAssuranceDependencies): Promise<{
  check: PeriodicAssuranceCheckResult;
  observation: PeriodicAssuranceResult["queue"];
}> {
  const unavailable = {
    check: failed("attachment_queue", "attachment_queue_failed"),
    observation: { depth: 0, oldestAgeSeconds: null }
  } as const;
  try {
    const state = await dependencies.inspectQueue();
    if (!Number.isSafeInteger(state.depth) || state.depth < 0) return unavailable;
    const now = dependencies.now().getTime();
    const insertedAt = state.oldestInsertedAt?.getTime();
    if (!Number.isFinite(now) || (insertedAt !== undefined && !Number.isFinite(insertedAt))) {
      return unavailable;
    }
    return {
      check: passed("attachment_queue"),
      observation: {
        depth: state.depth,
        oldestAgeSeconds:
          insertedAt === undefined ? null : Math.max(0, Math.floor((now - insertedAt) / 1_000))
      }
    };
  } catch {
    return unavailable;
  }
}

async function clamAvChecks(
  input: PeriodicAssuranceInput,
  dependencies: PeriodicAssuranceDependencies
): Promise<PeriodicAssuranceCheckResult[]> {
  let databaseDirectory: string;
  let signatureCheck: PeriodicAssuranceCheckResult;
  try {
    const assessment = assessClamAvSignatureManifest(
      await dependencies.readSignatureManifest(input.clamavSignatureManifestPath),
      dependencies.now()
    );
    if (assessment.status !== "usable") {
      return invalidManifestChecks();
    }
    signatureCheck =
      assessment.health === "warning"
        ? { name: "clamav_signature", status: "warning", code: "signature_warning" }
        : passed("clamav_signature");
    databaseDirectory = assessment.manifest.databaseDirectory
      ? posix.join(
          posix.dirname(input.clamavSignatureManifestPath.replaceAll("\\", "/")),
          assessment.manifest.databaseDirectory
        )
      : posix.dirname(input.clamavSignatureManifestPath.replaceAll("\\", "/"));
  } catch {
    return invalidManifestChecks();
  }

  const clean = await scanCheck(
    "clean",
    CLEAN_FILE_NAME,
    CLEAN_PAYLOAD,
    "clean",
    "clamav_clean",
    "clamav_clean_failed",
    databaseDirectory,
    input.scanTimeoutMs,
    dependencies
  );
  const eicar = await scanCheck(
    "eicar",
    EICAR_FILE_NAME,
    EICAR_PAYLOAD,
    "infected",
    "clamav_eicar",
    "clamav_eicar_failed",
    databaseDirectory,
    input.scanTimeoutMs,
    dependencies
  );
  return [signatureCheck, clean, eicar];
}

function invalidManifestChecks(): PeriodicAssuranceCheckResult[] {
  return [
    failed("clamav_signature", "clamav_manifest_invalid"),
    failed("clamav_clean", "clamav_manifest_invalid"),
    failed("clamav_eicar", "clamav_manifest_invalid")
  ];
}

async function scanCheck(
  kind: "clean" | "eicar",
  fileName: string,
  data: Uint8Array,
  expected: ClamAvCliScanResult["status"],
  name: "clamav_clean" | "clamav_eicar",
  failureCode: "clamav_clean_failed" | "clamav_eicar_failed",
  databaseDirectory: string,
  timeoutMs: number,
  dependencies: PeriodicAssuranceDependencies
): Promise<PeriodicAssuranceCheckResult> {
  try {
    const result = await dependencies.scanSample({
      kind,
      fileName,
      data,
      databaseDirectory,
      timeoutMs
    });
    return result.status === expected ? passed(name) : failed(name, failureCode);
  } catch {
    return failed(name, failureCode);
  }
}

async function diagnosticWriteDeleteCheck(
  input: PeriodicAssuranceInput,
  dependencies: PeriodicAssuranceDependencies
): Promise<PeriodicAssuranceCheckResult> {
  let folder: DriveItem;
  try {
    folder = await dependencies.ensureDiagnosticsFolder(
      input.graphDriveId,
      input.graphOtherFolderItemId,
      DIAGNOSTICS_FOLDER_NAME
    );
    if (!folder.id) return failed("diagnostic_write_delete", "diagnostic_folder_failed");
  } catch {
    return failed("diagnostic_write_delete", "diagnostic_folder_failed");
  }

  let uploaded: DriveItem | undefined;
  let uploadFailed = false;
  let deleteFailed = false;
  try {
    uploaded = await dependencies.uploadDiagnostic(
      input.graphDriveId,
      folder.id,
      DIAGNOSTIC_FILE_NAME,
      CLEAN_PAYLOAD,
      "text/plain"
    );
    uploadFailed = !uploaded.id;
  } catch {
    uploadFailed = true;
  } finally {
    if (uploaded?.id) {
      try {
        await dependencies.deleteDiagnostic(input.graphDriveId, uploaded.id);
      } catch {
        deleteFailed = true;
      }
    }
  }
  if (uploadFailed) return failed("diagnostic_write_delete", "diagnostic_upload_failed");
  return deleteFailed
    ? failed("diagnostic_write_delete", "diagnostic_delete_failed")
    : passed("diagnostic_write_delete");
}

function passed(name: PeriodicAssuranceCheckName): PeriodicAssuranceCheckResult {
  return { name, status: "passed", code: "none" };
}

function failed(
  name: PeriodicAssuranceCheckName,
  code: Exclude<PeriodicAssuranceFailureCode, "none" | "signature_warning">
): PeriodicAssuranceCheckResult {
  return { name, status: "failed", code };
}
