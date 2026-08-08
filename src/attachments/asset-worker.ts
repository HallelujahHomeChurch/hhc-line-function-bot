import {
  isPermanentAssetApiError,
  type AssetApiClient,
  type AssetRecord
} from "../clients/asset-api.js";
import type { ExternalBinaryClient } from "../clients/external-binary.js";
import {
  prepareResourceBinary,
  type PreparedResourceBinary,
  type ResourceBinaryPublisher,
  type ResourcePublishItemKind
} from "../functions/resource-binary-publisher.js";
import type { LineContentClient } from "../types.js";
import type { AttachmentScanWorkerProfile } from "./scan-worker-config.js";
import type {
  AttachmentScanFailureCode,
  AttachmentAssetUploadDescriptor,
  AttachmentScanWork,
  AttachmentScanWorkStore
} from "./scan-work-store.js";

export type AttachmentAssetWorkerResult =
  | { status: "completed"; signatureHealth: "current" }
  | { status: "permanent_failure"; failureCode: AttachmentScanFailureCode }
  | { status: "transient_retry"; failureCode: AttachmentScanFailureCode }
  | { status: "scan_pending" }
  | { status: "contention" }
  | { status: "missing" };

export async function runAttachmentAssetWorker(
  workId: string,
  options: {
    workStore: AttachmentScanWorkStore;
    assets: AssetApiClient;
    lineContent: LineContentClient;
    externalBinary?: ExternalBinaryClient;
    profiles: AttachmentScanWorkerProfile[];
    publisher: ResourceBinaryPublisher;
    maxBytes: number;
    lineDownloadTimeoutMs: number;
    externalDownloadTimeoutMs?: number;
    externalMaxRedirects?: number;
    scanDeadline: Date;
    publicationDeadline?: Date;
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
  }
): Promise<AttachmentAssetWorkerResult> {
  let claim: Awaited<ReturnType<AttachmentScanWorkStore["claimForProcessing"]>>;
  try {
    claim = await options.workStore.claimForProcessing(workId);
  } catch {
    return { status: "transient_retry", failureCode: "worker_failed" };
  }
  if (claim.disposition === "missing") return { status: "missing" };
  if (claim.disposition === "active") return { status: "contention" };
  if (claim.disposition === "terminal") {
    return claim.terminalStatus === "completed"
      ? { status: "completed", signatureHealth: "current" }
      : {
          status: "permanent_failure",
          failureCode: claim.failureCode ?? "worker_failed"
        };
  }
  const work = claim.work;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  let publishing = false;
  try {
    if (!validWorkTarget(work, options.profiles)) {
      return permanentFailure(options.workStore, work, "validation_failed");
    }

    let descriptor = work.uploadDescriptor;
    let resource: PreparedResourceBinary | undefined;
    let asset: AssetRecord;
    if (work.assetId) {
      if (!descriptor) {
        return permanentFailure(options.workStore, work, "validation_failed");
      }
      asset = await options.assets.get(work.assetId);
    } else {
      if (!descriptor) {
        resource = await prepareWorkResource(work, options);
        if (!resource) {
          return permanentFailure(options.workStore, work, "validation_failed");
        }
        descriptor = uploadDescriptor(resource);
        if (!(await options.workStore.recordUploadDescriptor(work.id, work.claimId!, descriptor))) {
          return { status: "contention" };
        }
      }

      const created = await options.assets.createUpload({
        workId: work.id,
        lineMessageId: work.lineMessageId ?? work.id,
        fileName: descriptor.fileName,
        mimeType: descriptor.mimeType,
        maxSizeBytes: descriptor.sizeBytes
      });
      asset = created.asset;
      if (asset.uploadStatus !== "completed") {
        if (asset.uploadStatus !== "created" || !created.uploadTarget) {
          return permanentFailure(options.workStore, work, "validation_failed");
        }
        resource ??= await prepareWorkResource(work, options);
        if (!resource || !matchesDescriptor(resource, descriptor)) {
          return permanentFailure(options.workStore, work, "validation_failed");
        }
        await options.assets.upload(created.uploadTarget, resource.data);
        asset = await options.assets.complete(asset.id, {
          sizeBytes: descriptor.sizeBytes,
          checksumSha256: descriptor.checksumSha256,
          mimeType: descriptor.mimeType
        });
      }
      if (!matchesAssetRecord(asset, descriptor)) {
        return permanentFailure(options.workStore, work, "validation_failed");
      }
      if (!(await options.workStore.recordAsset(work.id, work.claimId!, asset.id))) {
        return { status: "contention" };
      }
    }

    if (!matchesAssetRecord(asset, descriptor)) {
      return permanentFailure(options.workStore, work, "validation_failed");
    }

    asset = await waitForScan(asset, options.assets, options.scanDeadline, now, sleep);
    if (!matchesAssetRecord(asset, descriptor)) {
      return permanentFailure(options.workStore, work, "validation_failed");
    }
    if (asset.scanStatus === "pending" || asset.scanStatus === "scanning") {
      return scanPending(options.workStore, work);
    }
    if (asset.scanStatus === "infected") {
      return permanentFailure(options.workStore, work, "scan_infected");
    }
    if (asset.scanStatus !== "clean" || !asset.scanSignatureVersion) {
      return permanentFailure(options.workStore, work, "scan_unavailable");
    }

    await options.assets.grantServiceRead(asset.id, work.id);
    const clean = await options.assets.download(asset.id);
    const verified = prepareResourceBinary({
      binary: {
        data: clean.data,
        declaredFileName: descriptor.fileName,
        declaredContentType: asset.detectedMimeType ?? clean.contentType,
        sourceKind: "external"
      },
      target: workTarget(work),
      maxBytes: options.maxBytes
    });
    if (!verified.ok || !matchesDescriptor(verified.resource, descriptor)) {
      return permanentFailure(options.workStore, work, "validation_failed");
    }
    if (
      !(await options.workStore.beginPublishing(
        work.id,
        work.claimId!,
        options.publicationDeadline
      ))
    ) {
      return { status: "contention" };
    }
    publishing = true;
    const publication = await options.publisher.publishVerifiedResource({
      resource: verified.resource,
      scan: { status: "clean", signatureVersion: asset.scanSignatureVersion },
      now: now()
    });
    if (publication.status === "failed") {
      return permanentFailure(options.workStore, work, "publish_failed");
    }
    if (!(await options.workStore.complete(work.id, work.claimId!, publication.result))) {
      return { status: "contention" };
    }
    return { status: "completed", signatureHealth: "current" };
  } catch (error) {
    if (publishing) return { status: "contention" };
    return isPermanentAssetApiError(error)
      ? permanentFailure(options.workStore, work, "scan_unavailable")
      : transientRetry(options.workStore, work, "scan_unavailable");
  }
}

async function prepareWorkResource(
  work: AttachmentScanWork,
  options: {
    lineContent: LineContentClient;
    externalBinary?: ExternalBinaryClient;
    profiles: AttachmentScanWorkerProfile[];
    maxBytes: number;
    lineDownloadTimeoutMs: number;
    externalDownloadTimeoutMs?: number;
    externalMaxRedirects?: number;
  }
): Promise<PreparedResourceBinary | undefined> {
  const profile = options.profiles.find((candidate) => candidate.name === work.scope.profileName);
  if (!profile || !isResourcePublishItemKind(work.target.itemKind)) return undefined;
  const content = work.lineMessageId
    ? {
        ...(await options.lineContent.getMessageContent(work.lineMessageId, profile, {
          maxBytes: options.maxBytes,
          timeoutMs: options.lineDownloadTimeoutMs
        })),
        sourceKind: "line" as const
      }
    : options.externalBinary
      ? {
          ...(await options.externalBinary.download({
            url: work.externalUrl!,
            maxBytes: options.maxBytes,
            timeoutMs: options.externalDownloadTimeoutMs ?? 15_000,
            maxRedirects: options.externalMaxRedirects ?? 3
          })),
          sourceKind: "external" as const
        }
      : undefined;
  if (!content) return undefined;
  const prepared = prepareResourceBinary({
    binary: {
      data: content.data,
      declaredFileName:
        ("fileName" in content ? content.fileName : undefined) ??
        inferredFileName(work.target.title, content.contentType),
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
  return prepared.ok ? prepared.resource : undefined;
}

async function waitForScan(
  initial: AssetRecord,
  client: AssetApiClient,
  deadline: Date,
  now: () => Date,
  sleep: (milliseconds: number) => Promise<void>
): Promise<AssetRecord> {
  let asset = initial;
  const delays = [2_000, 5_000, 10_000];
  let attempt = 0;
  while ((asset.scanStatus === "pending" || asset.scanStatus === "scanning") && now() < deadline) {
    await sleep(delays[Math.min(attempt++, delays.length - 1)]!);
    asset = await client.get(asset.id);
  }
  return asset;
}

async function permanentFailure(
  store: AttachmentScanWorkStore,
  work: AttachmentScanWork,
  failureCode: AttachmentScanFailureCode
): Promise<AttachmentAssetWorkerResult> {
  try {
    return (await store.fail(work.id, work.claimId!, failureCode))
      ? { status: "permanent_failure", failureCode }
      : { status: "contention" };
  } catch {
    return { status: "transient_retry", failureCode: "worker_failed" };
  }
}

async function transientRetry(
  store: AttachmentScanWorkStore,
  work: AttachmentScanWork,
  failureCode: AttachmentScanFailureCode
): Promise<AttachmentAssetWorkerResult> {
  try {
    return (await store.releaseForRetry(work.id, work.claimId!))
      ? { status: "transient_retry", failureCode }
      : { status: "contention" };
  } catch {
    return { status: "transient_retry", failureCode };
  }
}

async function scanPending(
  store: AttachmentScanWorkStore,
  work: AttachmentScanWork
): Promise<AttachmentAssetWorkerResult> {
  try {
    return (await store.releaseForRetry(work.id, work.claimId!))
      ? { status: "scan_pending" }
      : { status: "contention" };
  } catch {
    return { status: "scan_pending" };
  }
}

function validWorkTarget(
  work: AttachmentScanWork,
  profiles: AttachmentScanWorkerProfile[]
): boolean {
  return (
    profiles.some((candidate) => candidate.name === work.scope.profileName) &&
    isResourcePublishItemKind(work.target.itemKind)
  );
}

function workTarget(work: AttachmentScanWork) {
  return {
    profileName: work.scope.profileName,
    sourceKey: work.target.sourceKey,
    itemKind: work.target.itemKind as ResourcePublishItemKind,
    domain: work.target.domain,
    title: work.target.title
  };
}

function uploadDescriptor(resource: PreparedResourceBinary): AttachmentAssetUploadDescriptor {
  return {
    fileName: resource.fileName,
    mimeType: resource.mimeType,
    sizeBytes: resource.sizeBytes,
    checksumSha256: resource.sha256
  };
}

function matchesDescriptor(
  resource: PreparedResourceBinary,
  descriptor: AttachmentAssetUploadDescriptor
): boolean {
  return (
    resource.fileName === descriptor.fileName &&
    resource.mimeType === descriptor.mimeType &&
    resource.sizeBytes === descriptor.sizeBytes &&
    resource.sha256 === descriptor.checksumSha256
  );
}

function matchesAssetRecord(
  asset: AssetRecord,
  descriptor: AttachmentAssetUploadDescriptor
): boolean {
  return (
    asset.uploadStatus === "completed" &&
    asset.sizeBytes === descriptor.sizeBytes &&
    asset.checksumSha256?.toLowerCase() === descriptor.checksumSha256 &&
    normalizedMime(asset.detectedMimeType) === normalizedMime(descriptor.mimeType)
  );
}

function normalizedMime(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function isResourcePublishItemKind(value: string): value is ResourcePublishItemKind {
  return [
    "ppt_slide",
    "pop_sheet",
    "hymn_sheet",
    "church_document",
    "church_image",
    "church_other"
  ].includes(value);
}

function inferredFileName(title: string, mime: string | undefined): string | undefined {
  const extension = (
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
    } as Record<string, string>
  )[mime?.split(";", 1)[0]?.trim().toLowerCase() ?? ""];
  return extension ? `${title}${extension}` : undefined;
}
