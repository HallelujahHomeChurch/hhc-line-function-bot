import type { AssetApiClient, AssetRecord } from "../clients/asset-api.js";
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
  AttachmentScanWork,
  AttachmentScanWorkStore
} from "./scan-work-store.js";
import type { AttachmentScanWorkerResult } from "./scan-worker.js";

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
): Promise<AttachmentScanWorkerResult> {
  const claim = await options.workStore.claimForProcessing(workId);
  if (claim.disposition !== "claimed") return { status: "ignored", reason: claim.disposition };
  const work = claim.work;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  try {
    const resource = await prepareWorkResource(work, options);
    if (!resource) return failWork(options.workStore, work, "validation_failed", false);

    let asset: AssetRecord;
    if (work.assetId) {
      asset = await options.assets.get(work.assetId);
    } else {
      const created = await options.assets.createUpload({
        workId: work.id,
        lineMessageId: work.lineMessageId ?? work.id,
        fileName: resource.fileName,
        mimeType: resource.mimeType,
        maxSizeBytes: resource.sizeBytes
      });
      asset = created.asset;
      if (asset.uploadStatus !== "completed") {
        if (!created.uploadTarget)
          return failWork(options.workStore, work, "validation_failed", false);
        await options.assets.upload(created.uploadTarget, resource.data);
        asset = await options.assets.complete(asset.id, {
          sizeBytes: resource.sizeBytes,
          checksumSha256: resource.sha256,
          mimeType: resource.mimeType
        });
      }
      if (!(await options.workStore.recordAsset(work.id, work.claimId!, asset.id))) {
        return { status: "ignored", reason: "active" };
      }
    }

    asset = await waitForScan(asset, options.assets, options.scanDeadline, now, sleep);
    if (asset.scanStatus === "pending" || asset.scanStatus === "scanning") {
      return { status: "ignored", reason: "active" };
    }
    if (asset.scanStatus === "infected") {
      return failWork(options.workStore, work, "scan_infected", false);
    }
    if (asset.scanStatus !== "clean" || !asset.scanSignatureVersion) {
      return failWork(options.workStore, work, "scan_unavailable", false);
    }

    await options.assets.grantServiceRead(asset.id, work.id);
    const clean = await options.assets.download(asset.id);
    const verified = prepareResourceBinary({
      binary: {
        data: clean.data,
        declaredFileName: resource.fileName,
        declaredContentType: clean.contentType,
        sourceKind: "external"
      },
      target: resource.target,
      maxBytes: options.maxBytes
    });
    if (!verified.ok || verified.resource.sha256 !== resource.sha256) {
      return failWork(options.workStore, work, "validation_failed", false);
    }
    if (
      !(await options.workStore.beginPublishing(
        work.id,
        work.claimId!,
        options.publicationDeadline
      ))
    ) {
      return { status: "ignored", reason: "active" };
    }
    const publication = await options.publisher.publishVerifiedResource({
      resource: verified.resource,
      scan: { status: "clean", signatureVersion: asset.scanSignatureVersion },
      now: now()
    });
    if (publication.status === "failed") {
      return failWork(options.workStore, work, "publish_failed", true);
    }
    if (!(await options.workStore.complete(work.id, work.claimId!, publication.result))) {
      return { status: "ignored", reason: "active" };
    }
    return { status: "completed", signatureHealth: "current" };
  } catch {
    return { status: "ignored", reason: "active" };
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

async function failWork(
  store: AttachmentScanWorkStore,
  work: AttachmentScanWork,
  failureCode: AttachmentScanFailureCode,
  infrastructureFailure: boolean
): Promise<AttachmentScanWorkerResult> {
  return (await store.fail(work.id, work.claimId!, failureCode))
    ? { status: "failed", failureCode, infrastructureFailure }
    : { status: "ignored", reason: "active" };
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
