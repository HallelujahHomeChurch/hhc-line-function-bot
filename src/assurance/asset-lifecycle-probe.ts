import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  isAssetAccessDeniedError,
  type AssetApiClient,
  type AssetRecord
} from "../clients/asset-api.js";

export interface AssetLifecycleAssuranceInput {
  operationTimeoutMs: number;
  cleanupTimeoutMs: number;
  pollIntervalMs: number;
}

export interface AssetLifecycleAssuranceResult {
  status: "passed" | "failed";
  code: "none" | "asset_lifecycle_failed" | "asset_cleanup_failed" | "timeout";
}

const OWNER_SERVICE = "hhc-line-function-bot";
const OWNER_TYPE = "assurance_probe";
const FILE_NAME = "asset-assurance.txt";
const MIME_TYPE = "text/plain";
const PAYLOAD = new TextEncoder().encode("HHC Asset assurance\n");
const CHECKSUM = createHash("sha256").update(PAYLOAD).digest("hex");

export async function runAssetLifecycleAssurance(
  input: AssetLifecycleAssuranceInput,
  assets: AssetApiClient
): Promise<AssetLifecycleAssuranceResult> {
  const ownerId = `asset-assurance:${randomUUID()}`;
  const createInput = {
    idempotencyKey: ownerId,
    ownerType: OWNER_TYPE,
    ownerId,
    purpose: "assurance",
    fileName: FILE_NAME,
    mimeType: MIME_TYPE,
    maxSizeBytes: PAYLOAD.byteLength
  };
  const grantIdempotencyKey = ownerId.replace("asset-assurance:", "asset-assurance-read:");
  const operationSignal = AbortSignal.timeout(input.operationTimeoutMs);
  let assetId: string | undefined;
  let grantId: string | undefined;
  let createAttempted = false;
  let grantAttempted = false;
  let result: AssetLifecycleAssuranceResult = {
    status: "failed",
    code: "asset_lifecycle_failed"
  };

  try {
    createAttempted = true;
    const created = await assets.createUpload(createInput, { signal: operationSignal });
    assetId = created.asset.id;
    if (!isExactOwner(created.asset, ownerId) || !created.uploadTarget) throw new Error();

    await assets.upload(created.uploadTarget, PAYLOAD, { signal: operationSignal });
    let asset = await assets.complete(
      assetId,
      {
        sizeBytes: PAYLOAD.byteLength,
        checksumSha256: CHECKSUM,
        mimeType: MIME_TYPE
      },
      { signal: operationSignal }
    );
    while (asset.scanStatus === "pending" || asset.scanStatus === "scanning") {
      await delay(input.pollIntervalMs, undefined, { signal: operationSignal });
      asset = await assets.get(assetId, { signal: operationSignal });
    }
    if (!isCleanAsset(asset, ownerId)) throw new Error();

    grantAttempted = true;
    grantId = (
      await assets.grantServiceRead(assetId, grantIdempotencyKey, {
        signal: operationSignal
      })
    ).id;
    const downloaded = await assets.download(assetId, { signal: operationSignal });
    if (
      downloaded.data.byteLength !== PAYLOAD.byteLength ||
      baseMime(downloaded.contentType) !== MIME_TYPE ||
      createHash("sha256").update(downloaded.data).digest("hex") !== CHECKSUM
    ) {
      throw new Error();
    }
    result = { status: "passed", code: "none" };
  } catch {
    result = {
      status: "failed",
      code: operationSignal.aborted ? "timeout" : "asset_lifecycle_failed"
    };
  } finally {
    if (
      await cleanupAsset(
        assets,
        {
          assetId,
          grantId,
          ownerId,
          createAttempted,
          createInput,
          grantAttempted,
          grantIdempotencyKey
        },
        AbortSignal.timeout(input.cleanupTimeoutMs)
      )
    ) {
      result = { status: "failed", code: "asset_cleanup_failed" };
    }
  }
  return result;
}

async function cleanupAsset(
  assets: AssetApiClient,
  identity: {
    assetId?: string;
    grantId?: string;
    ownerId: string;
    createAttempted: boolean;
    createInput: Parameters<AssetApiClient["createUpload"]>[0];
    grantAttempted: boolean;
    grantIdempotencyKey: string;
  },
  signal: AbortSignal
): Promise<boolean> {
  let failed = false;
  let assetId = identity.assetId;
  let grantId = identity.grantId;
  if (!assetId && identity.createAttempted) {
    try {
      const recovered = await assets.createUpload(identity.createInput, { signal });
      if (isExactOwner(recovered.asset, identity.ownerId)) {
        assetId = recovered.asset.id;
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    }
  }
  if (!assetId) return failed;
  if (!grantId && identity.grantAttempted) {
    try {
      grantId = (await assets.grantServiceRead(assetId, identity.grantIdempotencyKey, { signal }))
        .id;
    } catch {
      failed = true;
    }
  }
  if (grantId) {
    try {
      await assets.revokeGrant(assetId, grantId, { signal });
    } catch {
      failed = true;
    }
  }
  try {
    const asset = await assets.get(assetId, { signal });
    if (!isExactOwner(asset, identity.ownerId)) {
      failed = true;
    } else {
      await assets.softDelete(assetId, { signal });
    }
  } catch {
    failed = true;
  }
  try {
    await assets.download(assetId, { signal });
    failed = true;
  } catch (error) {
    if (!isAssetAccessDeniedError(error)) failed = true;
  }
  return failed || signal.aborted;
}

function isCleanAsset(asset: AssetRecord, ownerId: string): boolean {
  return (
    isExactOwner(asset, ownerId) &&
    asset.uploadStatus === "completed" &&
    asset.scanStatus === "clean" &&
    Boolean(asset.scanSignatureVersion?.trim()) &&
    asset.sizeBytes === PAYLOAD.byteLength &&
    asset.checksumSha256 === CHECKSUM &&
    baseMime(asset.detectedMimeType) === MIME_TYPE
  );
}

function isExactOwner(asset: AssetRecord, ownerId: string): boolean {
  return (
    asset.ownerService === OWNER_SERVICE &&
    asset.ownerType === OWNER_TYPE &&
    asset.ownerId === ownerId &&
    asset.visibility === "restricted"
  );
}

function baseMime(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}
