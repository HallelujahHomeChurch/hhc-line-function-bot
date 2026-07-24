import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import type {
  AttachmentScanFailureCode,
  AttachmentScanWork,
  AttachmentScanWorkStore
} from "./scan-work-store.js";
import type { ExternalBinaryClient } from "../clients/external-binary.js";
import type { AttachmentScanWorkerProfile } from "./scan-worker-config.js";
import {
  prepareResourceBinary,
  type ResourceBinaryPublisher,
  type ResourcePublishItemKind
} from "../functions/resource-binary-publisher.js";
import type { LineContentClient } from "../types.js";

const DEFAULT_SIGNATURE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_SCAN_TIMEOUT_MS = 15_000;

export interface ClamAvSignatureManifest {
  version: 1;
  signatureVersion: string;
  lastSuccessfulAt: string;
  databaseDirectory?: string;
}

export interface AttachmentFileScanner {
  scan(input: {
    filePath: string;
    databaseDirectory: string;
    timeoutMs: number;
  }): Promise<{ status: "clean" | "infected" | "unavailable" }>;
}

export interface AttachmentScanWorkerOptions {
  workStore: AttachmentScanWorkStore;
  lineContent: LineContentClient;
  externalBinary?: ExternalBinaryClient;
  profiles: AttachmentScanWorkerProfile[];
  publisher: ResourceBinaryPublisher;
  scanner: AttachmentFileScanner;
  readSignatureManifest: () => Promise<unknown>;
  databaseDirectory: string;
  maxBytes: number;
  lineDownloadTimeoutMs: number;
  externalDownloadTimeoutMs?: number;
  externalMaxRedirects?: number;
  scanTimeoutMs?: number;
  signatureMaxAgeMs?: number;
  now?: () => Date;
  temporaryRoot?: string;
}

export type AttachmentScanWorkerResult =
  | { status: "completed" }
  | { status: "ignored"; reason: "not_claimed" }
  | {
      status: "failed";
      failureCode: AttachmentScanFailureCode;
      infrastructureFailure: boolean;
    };

export async function runAttachmentScanWorker(
  workId: string,
  options: AttachmentScanWorkerOptions
): Promise<AttachmentScanWorkerResult> {
  const work = await options.workStore.claim(workId);
  if (!work) {
    return { status: "ignored", reason: "not_claimed" };
  }

  try {
    const signatureManifest = await options.readSignatureManifest();
    const now = options.now?.() ?? new Date();
    if (
      !isCurrentClamAvSignatureManifest(
        signatureManifest,
        now,
        options.signatureMaxAgeMs ?? DEFAULT_SIGNATURE_MAX_AGE_MS
      )
    ) {
      return failWork(options.workStore, work, "signature_stale", true);
    }

    const profile = options.profiles.find((candidate) => candidate.name === work.scope.profileName);
    if (!profile || !isResourcePublishItemKind(work.target.itemKind)) {
      return failWork(options.workStore, work, "validation_failed", false);
    }

    let content: {
      data: Uint8Array;
      contentType?: string;
      fileName?: string;
      sourceKind: "line" | "external";
    };
    try {
      if (work.lineMessageId) {
        const downloaded = await options.lineContent.getMessageContent(
          work.lineMessageId,
          profile,
          {
            maxBytes: options.maxBytes,
            timeoutMs: options.lineDownloadTimeoutMs
          }
        );
        content = { ...downloaded, sourceKind: "line" };
      } else {
        if (!options.externalBinary) throw new Error("external_binary_unavailable");
        const downloaded = await options.externalBinary.download({
          url: work.externalUrl!,
          maxBytes: options.maxBytes,
          timeoutMs: options.externalDownloadTimeoutMs ?? 15_000,
          maxRedirects: options.externalMaxRedirects ?? 3
        });
        content = {
          data: downloaded.data,
          contentType: downloaded.contentType,
          fileName: downloaded.fileName,
          sourceKind: "external"
        };
      }
    } catch {
      return failWork(options.workStore, work, "download_failed", true);
    }

    const inferredExtension = extensionForContentType(content.contentType);
    const preparation = prepareResourceBinary({
      binary: {
        data: content.data,
        declaredFileName:
          content.fileName ??
          (inferredExtension ? `${work.target.title}${inferredExtension}` : undefined),
        declaredContentType: content.contentType,
        sourceKind: content.sourceKind
      },
      target: {
        profileName: work.scope.profileName,
        sourceKey: work.target.sourceKey,
        itemKind: work.target.itemKind,
        domain: work.target.domain,
        title: work.target.title
      },
      maxBytes: options.maxBytes
    });
    if (!preparation.ok) {
      return failWork(options.workStore, work, "validation_failed", false);
    }

    let ephemeralDirectory: string | undefined;
    try {
      ephemeralDirectory = await mkdtemp(
        join(options.temporaryRoot ?? tmpdir(), "hhc-attachment-scan-")
      );
      const filePath = join(ephemeralDirectory, "payload");
      await writeFile(filePath, preparation.resource.data, { mode: 0o600 });

      let scan: Awaited<ReturnType<AttachmentFileScanner["scan"]>>;
      try {
        scan = await options.scanner.scan({
          filePath,
          databaseDirectory: databaseDirectoryForManifest(
            signatureManifest,
            options.databaseDirectory
          ),
          timeoutMs: options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
        });
      } catch {
        return failWork(options.workStore, work, "scan_unavailable", true);
      }

      if (scan.status === "infected") {
        return failWork(options.workStore, work, "scan_infected", false);
      }
      if (scan.status !== "clean") {
        return failWork(options.workStore, work, "scan_unavailable", true);
      }

      const publicationNow = options.now?.() ?? new Date();
      const publicationSignatureManifest = await options.readSignatureManifest();
      if (
        !isCurrentClamAvSignatureManifest(
          publicationSignatureManifest,
          publicationNow,
          options.signatureMaxAgeMs ?? DEFAULT_SIGNATURE_MAX_AGE_MS
        ) ||
        publicationSignatureManifest.signatureVersion !== signatureManifest.signatureVersion ||
        publicationSignatureManifest.databaseDirectory !== signatureManifest.databaseDirectory
      ) {
        return failWork(options.workStore, work, "signature_stale", true);
      }

      const publication = await options.publisher.publishVerifiedResource({
        resource: preparation.resource,
        scan: {
          status: "clean",
          signatureVersion: publicationSignatureManifest.signatureVersion
        },
        now: publicationNow
      });
      if (publication.status === "failed") {
        return failWork(options.workStore, work, "publish_failed", true);
      }
      const completed = await options.workStore.complete(
        work.id,
        work.claimId!,
        publication.result
      );
      if (!completed) {
        return {
          status: "failed",
          failureCode: "worker_failed",
          infrastructureFailure: true
        };
      }
      return { status: "completed" };
    } finally {
      if (ephemeralDirectory) {
        await rm(ephemeralDirectory, { recursive: true, force: true });
      }
    }
  } catch {
    return failWork(options.workStore, work, "worker_failed", true);
  }
}

export function isCurrentClamAvSignatureManifest(
  manifest: unknown,
  now: Date,
  maxAgeMs = DEFAULT_SIGNATURE_MAX_AGE_MS
): manifest is ClamAvSignatureManifest {
  if (!manifest || typeof manifest !== "object") return false;
  const value = manifest as Partial<ClamAvSignatureManifest>;
  if (
    value.version !== 1 ||
    typeof value.signatureVersion !== "string" ||
    !/^[A-Za-z0-9._-]{1,120}$/u.test(value.signatureVersion) ||
    typeof value.lastSuccessfulAt !== "string" ||
    (value.databaseDirectory !== undefined &&
      (typeof value.databaseDirectory !== "string" ||
        !/^sets\/[A-Za-z0-9._-]{1,120}$/u.test(value.databaseDirectory)))
  ) {
    return false;
  }
  const timestamp = Date.parse(value.lastSuccessfulAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.lastSuccessfulAt) {
    return false;
  }
  const ageMs = now.getTime() - timestamp;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function databaseDirectoryForManifest(
  manifest: ClamAvSignatureManifest,
  configuredDirectory: string
): string {
  if (!manifest.databaseDirectory) return configuredDirectory;
  return posix.join(configuredDirectory.replaceAll("\\", "/"), manifest.databaseDirectory);
}

async function failWork(
  store: AttachmentScanWorkStore,
  work: AttachmentScanWork,
  failureCode: AttachmentScanFailureCode,
  infrastructureFailure: boolean
): Promise<AttachmentScanWorkerResult> {
  const failed = await store.fail(work.id, work.claimId!, failureCode);
  if (!failed) {
    return {
      status: "failed",
      failureCode: "worker_failed",
      infrastructureFailure: true
    };
  }
  return { status: "failed", failureCode, infrastructureFailure };
}

function isResourcePublishItemKind(value: string): value is ResourcePublishItemKind {
  return (
    value === "ppt_slide" ||
    value === "pop_sheet" ||
    value === "hymn_sheet" ||
    value === "church_document" ||
    value === "church_image" ||
    value === "church_other"
  );
}

function extensionForContentType(contentType: string | undefined): string | undefined {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    {
      "application/pdf": ".pdf",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "application/vnd.ms-powerpoint": ".ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
      "application/vnd.apple.keynote": ".key",
      "application/vnd.oasis.opendocument.presentation": ".odp",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "text/plain": ".txt",
      "text/markdown": ".md"
    }[normalized ?? ""] ?? undefined
  );
}
