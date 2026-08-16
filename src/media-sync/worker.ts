import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

import {
  isPermanentAssetApiError,
  isTransientAssetApiError,
  type AssetApiClient,
  type AssetRecord
} from "../clients/asset-api.js";
import { LineContentReadError, lineContentFailureDisposition } from "../clients/line.js";
import type { AgentJobStore } from "../agent/jobs.js";
import {
  prepareResourceBinary,
  type ResourceBinaryPublisher,
  type ResourcePublishItemKind
} from "../functions/resource-binary-publisher.js";
import type { PostgresMediaSyncStore } from "./store.js";
import type { LineContentClient } from "../types.js";
import type { MediaSyncIngest, MediaSyncOutboxItem, MediaSyncWork } from "./types.js";
import { withMediaContentFile, type MediaContentFile } from "./content-file.js";

export const MEDIA_SYNC_MAX_BYTES = 209_715_200;

type AssetStageStore = Pick<
  PostgresMediaSyncStore,
  | "claimWork"
  | "loadClaimedWork"
  | "findActiveBinding"
  | "retryOutbox"
  | "failClaimedWork"
  | "persistCompletedAsset"
  | "finalizeCollectionPublication"
  | "completeClaimedWork"
  | "rememberExternalHandle"
  | "rememberOwnedAsset"
  | "tombstoneClaimedWorkForCleanup"
  | "finalizeManualPublication"
  | "failManualPublication"
>;

type MediaSyncSourceStageResult =
  | {
      status: "prepared";
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      checksumSha256: string;
    }
  | {
      status: "rescheduled";
      reason: "transcoding_processing" | "line_content_timeout" | "line_content_cancelled";
    }
  | {
      status: "permanent_failure";
      reason:
        | "transcoding_failed"
        | "line_content_empty"
        | "line_content_too_large"
        | "line_content_unavailable";
    }
  | { status: "contention" };

export type MediaSyncWorkerResult =
  | { status: "completed" }
  | { status: "missing" }
  | { status: "terminal" }
  | {
      status: "rescheduled";
      reason:
        | "transcoding_processing"
        | "line_content_timeout"
        | "line_content_cancelled"
        | "scan_pending"
        | "processing_pending"
        | "asset_unavailable"
        | "manual_pending";
    }
  | {
      status: "permanent_failure";
      reason:
        | "transcoding_failed"
        | "line_content_empty"
        | "line_content_too_large"
        | "line_content_unavailable"
        | "binding_inactive"
        | "asset_policy_rejected"
        | "scan_infected"
        | "scan_failed"
        | "processing_failed";
    }
  | { status: "contention" };

export function shouldAcknowledgeMediaSyncResult(result: MediaSyncWorkerResult): boolean {
  return (
    result.status === "completed" ||
    result.status === "missing" ||
    result.status === "terminal" ||
    result.status === "rescheduled" ||
    result.status === "permanent_failure"
  );
}

async function runClaimedSourceStage(
  workId: string,
  claim: MediaSyncOutboxItem & { claimedUntil: string },
  work: MediaSyncWork,
  options: {
    store: Pick<AssetStageStore, "retryOutbox" | "failClaimedWork">;
    lineContent: LineContentClient;
    profiles: Array<{ name: string; channelAccessToken: string }>;
    retryDelayMs: number;
    lineDownloadTimeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
    inspect?: (file: MediaContentFile) => Promise<void>;
  },
  now: Date
): Promise<MediaSyncSourceStageResult> {
  const profile = options.profiles.find((candidate) => candidate.name === work.ingest.profileName);
  if (!profile || !options.lineContent.getMessageContentStream) {
    return fail("line_content_unavailable", workId, claim.claimedUntil, options.store);
  }

  if (work.ingest.mediaKind === "video" || work.ingest.mediaKind === "audio") {
    if (!options.lineContent.getMessageContentTranscodingStatus) {
      return fail("line_content_unavailable", workId, claim.claimedUntil, options.store);
    }
    const status = await options.lineContent.getMessageContentTranscodingStatus(
      work.ingest.messageId,
      profile
    );
    if (status === "processing") {
      return retry(
        "transcoding_processing",
        work.ingest.sourceKey,
        claim.claimedUntil,
        new Date(now.getTime() + options.retryDelayMs),
        options.store
      );
    }
    if (status === "failed") {
      return fail("transcoding_failed", workId, claim.claimedUntil, options.store);
    }
  }

  try {
    const content = await options.lineContent.getMessageContentStream(
      work.ingest.messageId,
      profile
    );
    return await withMediaContentFile(
      content.stream,
      {
        maxBytes: options.maxBytes,
        timeoutMs: options.lineDownloadTimeoutMs,
        contentType: content.contentType,
        signal: options.signal
      },
      async (file) => {
        await options.inspect?.(file);
        return {
          status: "prepared" as const,
          fileName: safeMediaFileName(work.ingest),
          mimeType: file.contentType ?? work.ingest.expectedMime,
          sizeBytes: file.sizeBytes,
          checksumSha256: file.checksumSha256
        };
      }
    );
  } catch (error) {
    if (
      error instanceof LeaseFenceError ||
      error instanceof PermanentMediaSyncError ||
      isPermanentAssetApiError(error) ||
      isTransientAssetApiError(error)
    ) {
      throw error;
    }
    if (error instanceof LineContentReadError) {
      return error.code === "line_content_timeout" || error.code === "line_content_cancelled"
        ? retry(
            error.code,
            work.ingest.sourceKey,
            claim.claimedUntil,
            new Date(now.getTime() + options.retryDelayMs),
            options.store
          )
        : fail(error.code, workId, claim.claimedUntil, options.store);
    }
    return lineContentFailureDisposition(error) === "permanent"
      ? fail("line_content_unavailable", workId, claim.claimedUntil, options.store)
      : retry(
          "line_content_timeout",
          work.ingest.sourceKey,
          claim.claimedUntil,
          new Date(now.getTime() + options.retryDelayMs),
          options.store
        );
  }
}

export async function runMediaSyncWorker(
  workId: string,
  options: {
    store: AssetStageStore;
    assets: AssetApiClient;
    lineContent: LineContentClient;
    profiles: Array<{ name: string; channelAccessToken: string }>;
    workerLeaseMs: number;
    retryDelayMs: number;
    lineDownloadTimeoutMs: number;
    maxBytes: number;
    manualMaxBytes?: number;
    publisher?: ResourceBinaryPublisher;
    agentJobStore?: AgentJobStore;
    signal?: AbortSignal;
    now?: () => Date;
  }
): Promise<MediaSyncWorkerResult> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MEDIA_SYNC_MAX_BYTES
  ) {
    throw new Error("media_sync_max_bytes_invalid");
  }
  const now = options.now?.() ?? new Date();
  const claim = await options.store.claimWork({
    workId,
    operation: "intake",
    leaseMs: options.workerLeaseMs,
    now
  });
  if (claim === "missing" || claim === "terminal") return { status: claim };
  if (claim === "busy" || !claim.claimedUntil) return { status: "contention" };
  const loadedWork = await options.store.loadClaimedWork({
    workId,
    operation: "intake",
    expectedClaimedUntil: claim.claimedUntil
  });
  if (!loadedWork) return { status: "contention" };
  let work: MediaSyncWork = loadedWork;
  if (!(await activeBinding(work, options.store))) {
    return terminalFailure("binding_inactive", workId, claim.claimedUntil, work, now, options);
  }

  let asset: AssetRecord;
  try {
    if (work.ingest.assetId) {
      asset = await options.assets.get(work.ingest.assetId, { signal: options.signal });
      const eligibility = await eligibilityAfterExternal(workId, claim.claimedUntil, options.store);
      if (eligibility === "lease_lost") return { status: "contention" };
      if (eligibility === "binding_inactive") {
        return terminalFailure("binding_inactive", workId, claim.claimedUntil, work, now, options);
      }
      work = eligibility.work;
    } else {
      let completedAsset: AssetRecord | undefined;
      const sourceWork = work;
      const source = await runClaimedSourceStage(
        workId,
        claim as MediaSyncOutboxItem & { claimedUntil: string },
        sourceWork,
        {
          store: options.store,
          lineContent: options.lineContent,
          profiles: options.profiles,
          retryDelayMs: options.retryDelayMs,
          lineDownloadTimeoutMs: options.lineDownloadTimeoutMs,
          maxBytes: options.maxBytes,
          signal: options.signal,
          inspect: async (file) => {
            const created = await options.assets.createUpload(
              {
                namespace: "line.group.media-sync",
                idempotencyKey: idempotencyKey("media-sync-upload", sourceWork.ingest.sourceKey),
                ownerType: "media_sync_ingest",
                ownerId: sourceWork.ingest.workId,
                purpose: "media-sync",
                fileName: safeMediaFileName(sourceWork.ingest),
                mimeType: file.contentType ?? sourceWork.ingest.expectedMime,
                maxSizeBytes: file.sizeBytes
              },
              { signal: options.signal }
            );
            await requireEligibilityOrCompensateAsset(
              created.asset,
              workId,
              claim.claimedUntil!,
              options
            );
            let current = created.asset;
            if (current.uploadStatus !== "completed") {
              if (current.uploadStatus !== "created" || !created.uploadTarget) {
                await compensateOwnedAsset(current, workId, options);
                throw new PermanentMediaSyncError("asset_policy_rejected");
              }
              await options.assets.uploadFile(created.uploadTarget, file.path, {
                signal: options.signal
              });
              await requireEligibilityOrCompensateAsset(
                current,
                workId,
                claim.claimedUntil!,
                options
              );
              current = await options.assets.complete(
                current.id,
                {
                  sizeBytes: file.sizeBytes,
                  checksumSha256: file.checksumSha256,
                  mimeType: file.contentType ?? sourceWork.ingest.expectedMime
                },
                { signal: options.signal }
              );
              await requireEligibilityOrCompensateAsset(
                current,
                workId,
                claim.claimedUntil!,
                options
              );
            }
            if (current.uploadStatus !== "completed" || !current.etag?.trim()) {
              await compensateOwnedAsset(current, workId, options);
              throw new PermanentMediaSyncError("asset_policy_rejected");
            }
            if (
              !(await options.store.persistCompletedAsset({
                workId,
                expectedClaimedUntil: claim.claimedUntil!,
                assetId: current.id,
                assetEtag: current.etag,
                sizeBytes: file.sizeBytes,
                checksumSha256: file.checksumSha256
              }))
            ) {
              await compensateOwnedAsset(current, workId, options);
              throw new LeaseFenceError();
            }
            completedAsset = current;
          }
        },
        now
      );
      if (source.status !== "prepared") return source;
      if (!completedAsset) return { status: "contention" };
      asset = completedAsset;
      work =
        (await options.store.loadClaimedWork({
          workId,
          operation: "intake",
          expectedClaimedUntil: claim.claimedUntil
        })) ?? work;
    }

    if (
      asset.uploadStatus !== "completed" ||
      !asset.etag?.trim() ||
      (work.ingest.assetEtag !== undefined && work.ingest.assetEtag !== asset.etag)
    ) {
      return terminalFailure(
        "asset_policy_rejected",
        workId,
        claim.claimedUntil,
        work,
        now,
        options
      );
    }
    if (asset.scanStatus === "pending" || asset.scanStatus === "scanning") {
      return retryWorker("scan_pending", work.ingest.sourceKey, claim.claimedUntil, now, options);
    }
    if (asset.scanStatus === "infected") {
      return terminalFailure("scan_infected", workId, claim.claimedUntil, work, now, options);
    }
    if (asset.scanStatus === "failed") {
      return terminalFailure("scan_failed", workId, claim.claimedUntil, work, now, options);
    }
    if (asset.processingStatus === "pending") {
      return retryWorker(
        "processing_pending",
        work.ingest.sourceKey,
        claim.claimedUntil,
        now,
        options
      );
    }
    if (asset.processingStatus === "failed") {
      return terminalFailure("processing_failed", workId, claim.claimedUntil, work, now, options);
    }
    if (asset.scanStatus !== "clean") {
      return terminalFailure("scan_failed", workId, claim.claimedUntil, work, now, options);
    }

    const collection = work.publications.find(
      (publication) => publication.publicationType === "collection"
    );
    if (!collection) {
      return terminalFailure(
        "asset_policy_rejected",
        workId,
        claim.claimedUntil,
        work,
        now,
        options
      );
    }
    if (collection.targetId && collection.state === "pending") {
      if (
        !(await options.store.finalizeCollectionPublication({
          workId,
          expectedClaimedUntil: claim.claimedUntil,
          collectionId: work.ingest.collectionId,
          occurrenceId: collection.targetId
        }))
      ) {
        return { status: "contention" };
      }
      collection.state = "published";
    } else if (!collection.targetId) {
      const sourceRevision = work.ingest.checksumSha256 ?? asset.etag ?? work.ingest.assetEtag;
      if (!sourceRevision) {
        return terminalFailure(
          "asset_policy_rejected",
          workId,
          claim.claimedUntil,
          work,
          now,
          options
        );
      }
      const mutation = await options.assets.addCollectionItem(
        work.ingest.collectionId,
        {
          assetId: asset.id,
          remoteItemId: work.ingest.workId,
          displayName: safeMediaFileName(work.ingest),
          sourceRevision
        },
        idempotencyKey("media-sync-collection", work.ingest.sourceKey),
        { signal: options.signal }
      );
      const eligibility = await eligibilityAfterExternal(workId, claim.claimedUntil, options.store);
      const finalized =
        eligibility !== "lease_lost" &&
        eligibility !== "binding_inactive" &&
        (await options.store.finalizeCollectionPublication({
          workId,
          expectedClaimedUntil: claim.claimedUntil,
          collectionId: work.ingest.collectionId,
          occurrenceId: mutation.item.id
        }));
      if (!finalized) {
        await compensateOccurrence(workId, work.ingest.collectionId, mutation.item.id, options);
        return { status: "contention" };
      }
    }
    const manual = work.publications.find(
      (publication) => publication.publicationType === "manual"
    );
    if (manual?.state === "pending" && isConfirmedManualPublication(manual)) {
      if (manual.targetId) {
        if (
          !(await options.store.finalizeManualPublication({
            workId,
            expectedClaimedUntil: claim.claimedUntil,
            destinationId: manual.destinationId,
            resourceId: manual.targetId
          }))
        ) {
          return { status: "contention" };
        }
        manual.state = "published";
      } else {
        const manualResult = await publishManualResource({
          workId,
          work,
          asset,
          publication: manual,
          expectedClaimedUntil: claim.claimedUntil,
          now,
          options
        });
        if (manualResult) return manualResult;
      }
    }
    if (manual?.state === "published" && manual.jobId && options.agentJobStore) {
      try {
        await options.agentJobStore.complete(
          manual.jobId,
          { ok: true, executedAction: "save_resource", replyText: "檔案已保存。" },
          "save_resource"
        );
      } catch {
        return retryWorker(
          "manual_pending",
          work.ingest.sourceKey,
          claim.claimedUntil,
          now,
          options
        );
      }
    }
    return (await options.store.completeClaimedWork({
      workId,
      expectedClaimedUntil: claim.claimedUntil
    }))
      ? { status: "completed" }
      : { status: "contention" };
  } catch (error) {
    if (error instanceof LeaseFenceError) return { status: "contention" };
    if (error instanceof PermanentMediaSyncError || isPermanentAssetApiError(error)) {
      return terminalFailure(
        error instanceof PermanentMediaSyncError ? error.reason : "asset_policy_rejected",
        workId,
        claim.claimedUntil,
        work,
        now,
        options
      );
    }
    return retryWorker(
      "asset_unavailable",
      work.ingest.sourceKey,
      claim.claimedUntil,
      now,
      options
    );
  }
}

async function publishManualResource(input: {
  workId: string;
  work: MediaSyncWork;
  asset: AssetRecord;
  publication: MediaSyncWork["publications"][number] & {
    jobId: string;
    manualSourceKey: string;
    manualItemKind: string;
    manualDomain: string;
    manualTitle: string;
  };
  expectedClaimedUntil: string;
  now: Date;
  options: {
    store: AssetStageStore;
    assets: AssetApiClient;
    publisher?: ResourceBinaryPublisher;
    agentJobStore?: AgentJobStore;
    manualMaxBytes?: number;
    signal?: AbortSignal;
    retryDelayMs: number;
  };
}): Promise<MediaSyncWorkerResult | undefined> {
  const { publication, options } = input;
  const maxBytes = options.manualMaxBytes ?? 25 * 1024 * 1024;
  const knownSize = input.work.ingest.sizeBytes ?? input.asset.sizeBytes;
  if (knownSize !== undefined && knownSize > maxBytes) {
    return failManualBranch(input, "manual_file_too_large");
  }
  if (
    !options.publisher ||
    !options.agentJobStore ||
    !isResourcePublishItemKind(publication.manualItemKind) ||
    !input.asset.scanSignatureVersion?.trim()
  ) {
    return failManualBranch(input, "manual_publish_unavailable");
  }

  try {
    await options.assets.grantServiceRead(
      input.asset.id,
      idempotencyKey("media-sync-manual-read", input.work.ingest.sourceKey),
      { signal: options.signal }
    );
  } catch (error) {
    return isPermanentAssetApiError(error)
      ? failManualBranch(input, "manual_asset_rejected")
      : retryWorker(
          "manual_pending",
          input.work.ingest.sourceKey,
          input.expectedClaimedUntil,
          input.now,
          options
        );
  }
  let eligibility = await eligibilityAfterExternal(
    input.workId,
    input.expectedClaimedUntil,
    options.store
  );
  if (eligibility === "lease_lost" || eligibility === "binding_inactive") {
    return { status: "contention" };
  }
  let binary: Awaited<ReturnType<AssetApiClient["download"]>>;
  try {
    binary = await options.assets.download(input.asset.id, { signal: options.signal });
  } catch (error) {
    return isPermanentAssetApiError(error)
      ? failManualBranch(input, "manual_asset_rejected")
      : retryWorker(
          "manual_pending",
          input.work.ingest.sourceKey,
          input.expectedClaimedUntil,
          input.now,
          options
        );
  }
  eligibility = await eligibilityAfterExternal(
    input.workId,
    input.expectedClaimedUntil,
    options.store
  );
  if (eligibility === "lease_lost" || eligibility === "binding_inactive") {
    return { status: "contention" };
  }
  const prepared = prepareResourceBinary({
    binary: {
      data: binary.data,
      declaredFileName: safeMediaFileName(input.work.ingest),
      declaredContentType: binary.contentType ?? input.asset.detectedMimeType,
      sourceKind: "line"
    },
    target: {
      profileName: input.work.ingest.profileName,
      sourceKey: publication.manualSourceKey,
      itemKind: publication.manualItemKind,
      domain: publication.manualDomain,
      title: publication.manualTitle
    },
    maxBytes
  });
  if (!prepared.ok) return failManualBranch(input, "manual_format_rejected");

  const outcome = await options.publisher.publishVerifiedResource({
    resource: prepared.resource,
    scan: { status: "clean", signatureVersion: input.asset.scanSignatureVersion },
    now: input.now
  });
  if (outcome.status === "failed") return failManualBranch(input, "manual_publish_failed");
  if (outcome.status === "duplicate") {
    const failed = await options.store.failManualPublication({
      workId: input.workId,
      expectedClaimedUntil: input.expectedClaimedUntil,
      destinationId: publication.destinationId,
      failureCategory: "manual_duplicate"
    });
    if (!failed) return { status: "contention" };
    publication.state = "failed";
    try {
      await options.agentJobStore.complete(publication.jobId, outcome.result, "save_resource");
    } catch {
      // The durable duplicate disposition is authoritative.
    }
    return undefined;
  }
  eligibility = await eligibilityAfterExternal(
    input.workId,
    input.expectedClaimedUntil,
    options.store
  );
  const finalized =
    eligibility !== "lease_lost" &&
    eligibility !== "binding_inactive" &&
    (await options.store.finalizeManualPublication({
      workId: input.workId,
      expectedClaimedUntil: input.expectedClaimedUntil,
      destinationId: publication.destinationId,
      resourceId: outcome.resourceId
    }));
  if (!finalized) {
    const compensated = await options.publisher.tombstonePublishedResource(
      outcome.resourceId,
      input.now
    );
    if (!compensated) {
      await options.store.rememberExternalHandle({
        workId: input.workId,
        publicationType: "manual",
        destinationId: publication.destinationId,
        targetId: outcome.resourceId
      });
    }
    return { status: "contention" };
  }
  publication.state = "published";
  publication.targetId = outcome.resourceId;
  try {
    await options.agentJobStore.complete(publication.jobId, outcome.result, "save_resource");
  } catch {
    return retryWorker(
      "manual_pending",
      input.work.ingest.sourceKey,
      input.expectedClaimedUntil,
      input.now,
      options
    );
  }
  return undefined;
}

async function failManualBranch(
  input: {
    workId: string;
    work: MediaSyncWork;
    publication: MediaSyncWork["publications"][number] & { jobId: string };
    expectedClaimedUntil: string;
    options: { store: AssetStageStore; agentJobStore?: AgentJobStore };
  },
  failureCategory: string
): Promise<MediaSyncWorkerResult | undefined> {
  const failed = await input.options.store.failManualPublication({
    workId: input.workId,
    expectedClaimedUntil: input.expectedClaimedUntil,
    destinationId: input.publication.destinationId,
    failureCategory
  });
  if (!failed) return { status: "contention" };
  input.publication.state = "failed";
  try {
    await input.options.agentJobStore?.fail(input.publication.jobId, failureCategory);
  } catch {
    // The durable publication state remains authoritative.
  }
  return undefined;
}

function isConfirmedManualPublication(
  publication: MediaSyncWork["publications"][number]
): publication is MediaSyncWork["publications"][number] & {
  jobId: string;
  manualSourceKey: string;
  manualItemKind: string;
  manualDomain: string;
  manualTitle: string;
} {
  return Boolean(
    publication.jobId &&
    publication.manualSourceKey &&
    publication.manualItemKind &&
    publication.manualDomain &&
    publication.manualTitle
  );
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

class LeaseFenceError extends Error {}

class PermanentMediaSyncError extends Error {
  constructor(
    readonly reason:
      | "binding_inactive"
      | "asset_policy_rejected"
      | "scan_infected"
      | "scan_failed"
      | "processing_failed"
  ) {
    super(reason);
  }
}

async function activeBinding(work: MediaSyncWork, store: AssetStageStore): Promise<boolean> {
  const binding = await store.findActiveBinding({
    profileName: work.ingest.profileName,
    groupId: work.ingest.groupId
  });
  return binding?.collectionId === work.ingest.collectionId;
}

async function eligibilityAfterExternal(
  workId: string,
  expectedClaimedUntil: string,
  store: AssetStageStore
): Promise<{ work: MediaSyncWork } | "lease_lost" | "binding_inactive"> {
  const work = await store.loadClaimedWork({
    workId,
    operation: "intake",
    expectedClaimedUntil
  });
  if (!work) return "lease_lost";
  return (await activeBinding(work, store)) ? { work } : "binding_inactive";
}

async function requireEligibilityOrCompensateAsset(
  asset: AssetRecord,
  workId: string,
  expectedClaimedUntil: string,
  options: { store: AssetStageStore; assets: AssetApiClient }
): Promise<void> {
  const eligibility = await eligibilityAfterExternal(workId, expectedClaimedUntil, options.store);
  if (eligibility !== "lease_lost" && eligibility !== "binding_inactive") return;
  await compensateOwnedAsset(asset, workId, options);
  if (eligibility === "binding_inactive") throw new PermanentMediaSyncError("binding_inactive");
  throw new LeaseFenceError();
}

async function compensateOwnedAsset(
  asset: Pick<AssetRecord, "id" | "etag">,
  workId: string,
  options: { store: AssetStageStore; assets: AssetApiClient }
): Promise<boolean> {
  try {
    await options.assets.softDelete(asset.id);
    return true;
  } catch {
    await options.store.rememberOwnedAsset({
      workId,
      assetId: asset.id,
      ...(asset.etag ? { assetEtag: asset.etag } : {})
    });
    return false;
  }
}

async function compensateOccurrence(
  workId: string,
  collectionId: string,
  occurrenceId: string,
  options: { store: AssetStageStore; assets: AssetApiClient }
): Promise<boolean> {
  try {
    await options.assets.deleteCollectionItem(
      collectionId,
      occurrenceId,
      idempotencyKey("media-sync-collection-compensate", workId)
    );
    return true;
  } catch {
    await options.store.rememberExternalHandle({
      workId,
      publicationType: "collection",
      destinationId: collectionId,
      targetId: occurrenceId
    });
    return false;
  }
}

async function retryWorker(
  reason: "scan_pending" | "processing_pending" | "asset_unavailable" | "manual_pending",
  sourceKey: string,
  expectedClaimedUntil: string,
  now: Date,
  options: { store: AssetStageStore; retryDelayMs: number }
): Promise<MediaSyncWorkerResult> {
  const released = await options.store.retryOutbox({
    sourceKey,
    operation: "intake",
    expectedClaimedUntil,
    availableAt: new Date(now.getTime() + options.retryDelayMs),
    lastErrorCategory: reason
  });
  return released ? { status: "rescheduled", reason } : { status: "contention" };
}

async function terminalFailure(
  reason:
    | "binding_inactive"
    | "asset_policy_rejected"
    | "scan_infected"
    | "scan_failed"
    | "processing_failed",
  workId: string,
  expectedClaimedUntil: string,
  work: MediaSyncWork,
  now: Date,
  options: {
    store: AssetStageStore;
    assets: AssetApiClient;
    publisher?: ResourceBinaryPublisher;
  }
): Promise<MediaSyncWorkerResult> {
  const current =
    (await options.store.loadClaimedWork({
      workId,
      operation: "intake",
      expectedClaimedUntil
    })) ?? work;
  const compensated = await compensatePersistedOwners(workId, current, now, options);
  if (!compensated) {
    return (await options.store.tombstoneClaimedWorkForCleanup({
      workId,
      expectedClaimedUntil
    }))
      ? { status: "permanent_failure", reason }
      : { status: "contention" };
  }
  return failWorker(reason, workId, expectedClaimedUntil, options.store);
}

async function compensatePersistedOwners(
  workId: string,
  work: MediaSyncWork,
  now: Date,
  options: {
    store: AssetStageStore;
    assets: AssetApiClient;
    publisher?: ResourceBinaryPublisher;
  }
): Promise<boolean> {
  let compensated = true;
  if (work.ingest.assetId) {
    if (
      !(await compensateOwnedAsset(
        {
          id: work.ingest.assetId,
          ...(work.ingest.assetEtag ? { etag: work.ingest.assetEtag } : {})
        },
        workId,
        options
      ))
    ) {
      compensated = false;
    }
  }
  for (const publication of work.publications) {
    if (!publication.targetId) continue;
    if (publication.publicationType === "collection") {
      if (
        !(await compensateOccurrence(
          workId,
          publication.destinationId,
          publication.targetId,
          options
        ))
      ) {
        compensated = false;
      }
      continue;
    }
    const manualCompensated =
      options.publisher &&
      (await options.publisher.tombstonePublishedResource(publication.targetId, now));
    if (!manualCompensated) {
      await options.store.rememberExternalHandle({
        workId,
        publicationType: "manual",
        destinationId: publication.destinationId,
        targetId: publication.targetId
      });
      compensated = false;
    }
  }
  return compensated;
}

async function failWorker(
  reason:
    | "binding_inactive"
    | "asset_policy_rejected"
    | "scan_infected"
    | "scan_failed"
    | "processing_failed",
  workId: string,
  expectedClaimedUntil: string,
  store: AssetStageStore
): Promise<MediaSyncWorkerResult> {
  const terminal = await store.failClaimedWork({
    workId,
    expectedClaimedUntil,
    failureCategory: reason
  });
  return terminal ? { status: "permanent_failure", reason } : { status: "contention" };
}

function idempotencyKey(prefix: string, identity: string): string {
  return `${prefix}:${createHash("sha256").update(identity).digest("hex")}`;
}

export function safeMediaFileName(ingest: MediaSyncIngest): string {
  const declared = ingest.displayName.trim();
  if (
    declared &&
    basename(declared) === declared &&
    !hasControlCharacters(declared) &&
    Buffer.byteLength(declared) <= 255
  ) {
    return declared;
  }
  const suffix = createHash("sha256").update(ingest.sourceKey).digest("hex").slice(0, 12);
  return `${ingest.mediaKind}-${suffix}${safeFallbackExtension(ingest)}`;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function safeFallbackExtension(ingest: MediaSyncIngest): string {
  const extension = extname(ingest.displayName).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/u.test(extension)) return extension;
  return { image: ".jpg", video: ".mp4", audio: ".m4a", file: ".bin" }[ingest.mediaKind];
}

async function retry(
  reason: "transcoding_processing" | "line_content_timeout" | "line_content_cancelled",
  sourceKey: string,
  expectedClaimedUntil: string,
  availableAt: Date,
  store: Pick<AssetStageStore, "retryOutbox" | "failClaimedWork">
): Promise<MediaSyncSourceStageResult> {
  const released = await store.retryOutbox({
    sourceKey,
    operation: "intake",
    expectedClaimedUntil,
    availableAt,
    lastErrorCategory: reason
  });
  return released ? { status: "rescheduled", reason } : { status: "contention" };
}

async function fail(
  reason:
    | "transcoding_failed"
    | "line_content_empty"
    | "line_content_too_large"
    | "line_content_unavailable",
  workId: string,
  expectedClaimedUntil: string,
  store: Pick<AssetStageStore, "retryOutbox" | "failClaimedWork">
): Promise<MediaSyncSourceStageResult> {
  const terminal = await store.failClaimedWork({
    workId,
    expectedClaimedUntil,
    failureCategory: reason
  });
  return terminal ? { status: "permanent_failure", reason } : { status: "contention" };
}
