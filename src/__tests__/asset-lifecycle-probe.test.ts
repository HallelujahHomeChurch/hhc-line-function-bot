import { describe, expect, it, vi } from "vitest";

import {
  runAssetLifecycleAssurance,
  type AssetLifecycleAssuranceInput
} from "../assurance/asset-lifecycle-probe.js";
import type { AssetApiClient, AssetRecord } from "../clients/asset-api.js";

const PAYLOAD = new TextEncoder().encode("HHC Asset assurance\n");
const CHECKSUM = "ee40e49c5eed4667bac3f742e35909c85337352024d29640c9203c76fd42d20d";
const INPUT: AssetLifecycleAssuranceInput = {
  operationTimeoutMs: 1_000,
  cleanupTimeoutMs: 1_000,
  pollIntervalMs: 1
};

describe("Asset lifecycle assurance", () => {
  it("verifies the restricted clean lifecycle and exact cleanup without exposing payloads", async () => {
    const fixture = assetClient();

    const result = await runAssetLifecycleAssurance(INPUT, fixture.client);

    expect(result).toEqual({ status: "passed", code: "none" });
    expect(fixture.client.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^asset-assurance:[0-9a-f-]{36}$/u),
        ownerType: "assurance_probe",
        ownerId: expect.stringMatching(/^asset-assurance:[0-9a-f-]{36}$/u),
        purpose: "assurance",
        fileName: "asset-assurance.txt",
        mimeType: "text/plain",
        maxSizeBytes: PAYLOAD.byteLength
      }),
      { signal: expect.any(AbortSignal) }
    );
    const createInput = vi.mocked(fixture.client.createUpload).mock.calls[0]![0];
    expect(createInput.ownerId).toBe(createInput.idempotencyKey);
    expect(fixture.client.upload).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://blob.invalid/private-sas" }),
      PAYLOAD,
      { signal: expect.any(AbortSignal) }
    );
    expect(fixture.client.complete).toHaveBeenCalledWith(
      "asset-opaque-1",
      {
        sizeBytes: 20,
        checksumSha256: CHECKSUM,
        mimeType: "text/plain"
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(fixture.client.grantServiceRead).toHaveBeenCalledWith(
      "asset-opaque-1",
      createInput.idempotencyKey.replace("asset-assurance:", "asset-assurance-read:"),
      { signal: expect.any(AbortSignal) }
    );
    expect(fixture.client.revokeGrant).toHaveBeenCalledWith("asset-opaque-1", "grant-opaque-1", {
      signal: expect.any(AbortSignal)
    });
    expect(fixture.client.softDelete).toHaveBeenCalledWith("asset-opaque-1", {
      signal: expect.any(AbortSignal)
    });
    expect(fixture.client.download).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/token|private-sas|HHC Asset assurance/iu);
  });

  it("refuses to delete an asset whose exact assurance owner cannot be verified", async () => {
    const fixture = assetClient();
    let reads = 0;
    vi.mocked(fixture.client.get).mockImplementation(async () =>
      reads++ === 0 ? cleanAsset(fixture.ownerId) : cleanAsset("asset-assurance:different-owner")
    );

    const result = await runAssetLifecycleAssurance(INPUT, fixture.client);

    expect(result).toEqual({ status: "failed", code: "asset_cleanup_failed" });
    expect(fixture.client.revokeGrant).toHaveBeenCalledOnce();
    expect(fixture.client.softDelete).not.toHaveBeenCalled();
  });

  it("keeps cleaning after revoke failure and makes cleanup failure authoritative", async () => {
    const fixture = assetClient();
    vi.mocked(fixture.client.revokeGrant).mockRejectedValue(
      new Error("grant-secret https://asset.invalid/grants/secret")
    );

    const result = await runAssetLifecycleAssurance(INPUT, fixture.client);

    expect(result).toEqual({ status: "failed", code: "asset_cleanup_failed" });
    expect(fixture.client.softDelete).toHaveBeenCalledOnce();
    expect(fixture.client.download).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/grant-secret|https:/u);
  });

  it("aborts a blocked Asset operation at the hard deadline", async () => {
    const fixture = assetClient();
    let attempts = 0;
    vi.mocked(fixture.client.createUpload).mockImplementation((input, options) => {
      fixture.setOwnerId(input.ownerId);
      attempts += 1;
      if (attempts > 1) return Promise.resolve(createdAsset(input.ownerId));
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true
        });
      });
    });

    const result = await runAssetLifecycleAssurance(
      { ...INPUT, operationTimeoutMs: 20 },
      fixture.client
    );

    expect(result).toEqual({ status: "failed", code: "timeout" });
    expect(fixture.client.grantServiceRead).not.toHaveBeenCalled();
    expect(fixture.client.softDelete).toHaveBeenCalledOnce();
  });

  it("recovers a committed create after its response is lost and deletes the exact asset", async () => {
    const fixture = assetClient();
    let attempts = 0;
    vi.mocked(fixture.client.createUpload).mockImplementation(async (input) => {
      fixture.setOwnerId(input.ownerId);
      attempts += 1;
      if (attempts === 1) throw new Error("lost create response");
      return createdAsset(input.ownerId);
    });

    const result = await runAssetLifecycleAssurance(INPUT, fixture.client);

    expect(result).toEqual({ status: "failed", code: "asset_lifecycle_failed" });
    expect(fixture.client.createUpload).toHaveBeenCalledTimes(2);
    const [initialInput, initialOptions] = vi.mocked(fixture.client.createUpload).mock.calls[0]!;
    const [recoveryInput, recoveryOptions] = vi.mocked(fixture.client.createUpload).mock.calls[1]!;
    expect(recoveryInput).toBe(initialInput);
    expect(recoveryOptions?.signal).not.toBe(initialOptions?.signal);
    expect(fixture.client.softDelete).toHaveBeenCalledWith("asset-opaque-1", {
      signal: recoveryOptions?.signal
    });
    expect(fixture.client.grantServiceRead).not.toHaveBeenCalled();
  });

  it("recovers and revokes a committed grant after its response is lost", async () => {
    const fixture = assetClient();
    vi.mocked(fixture.client.grantServiceRead)
      .mockRejectedValueOnce(new Error("lost grant response"))
      .mockResolvedValueOnce({ id: "grant-opaque-1" });

    const result = await runAssetLifecycleAssurance(INPUT, fixture.client);

    expect(result).toEqual({ status: "failed", code: "asset_lifecycle_failed" });
    expect(fixture.client.grantServiceRead).toHaveBeenCalledTimes(2);
    const [initialAssetId, initialKey, initialOptions] = vi.mocked(fixture.client.grantServiceRead)
      .mock.calls[0]!;
    const [recoveryAssetId, recoveryKey, recoveryOptions] = vi.mocked(
      fixture.client.grantServiceRead
    ).mock.calls[1]!;
    expect([recoveryAssetId, recoveryKey]).toEqual([initialAssetId, initialKey]);
    expect(recoveryOptions?.signal).not.toBe(initialOptions?.signal);
    expect(fixture.client.revokeGrant).toHaveBeenCalledWith("asset-opaque-1", "grant-opaque-1", {
      signal: recoveryOptions?.signal
    });
    expect(fixture.client.softDelete).toHaveBeenCalledOnce();
  });

  it("makes cleanup failure authoritative after recovering an unknown grant", async () => {
    const fixture = assetClient();
    vi.mocked(fixture.client.grantServiceRead)
      .mockRejectedValueOnce(new Error("lost grant response"))
      .mockResolvedValueOnce({ id: "grant-opaque-1" });
    vi.mocked(fixture.client.revokeGrant).mockRejectedValue(new Error("revoke unavailable"));

    const result = await runAssetLifecycleAssurance(INPUT, fixture.client);

    expect(result).toEqual({ status: "failed", code: "asset_cleanup_failed" });
    expect(fixture.client.grantServiceRead).toHaveBeenCalledTimes(2);
    expect(fixture.client.revokeGrant).toHaveBeenCalledOnce();
    expect(fixture.client.softDelete).toHaveBeenCalledOnce();
  });
});

function assetClient(): {
  client: AssetApiClient;
  ownerId: string;
  setOwnerId(value: string): void;
} {
  let ownerId = "";
  let deleted = false;
  const client: AssetApiClient = {
    createUpload: vi.fn().mockImplementation(async (input) => {
      ownerId = input.ownerId;
      return {
        asset: {
          id: "asset-opaque-1",
          ownerService: "hhc-line-function-bot",
          ownerType: "assurance_probe",
          ownerId,
          visibility: "restricted",
          uploadStatus: "created",
          scanStatus: "pending"
        },
        uploadTarget: {
          url: "https://blob.invalid/private-sas",
          method: "PUT",
          headers: { "x-secret": "upload-secret" }
        }
      };
    }),
    upload: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockImplementation(async () => pendingAsset(ownerId)),
    get: vi.fn().mockImplementation(async () => cleanAsset(ownerId)),
    grantServiceRead: vi.fn().mockResolvedValue({ id: "grant-opaque-1" }),
    revokeGrant: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockImplementation(async () => {
      if (deleted) throw new Error("asset_api_404");
      return { data: PAYLOAD, contentType: "text/plain; charset=utf-8" };
    }),
    softDelete: vi.fn().mockImplementation(async () => {
      deleted = true;
    })
  };
  return {
    client,
    get ownerId() {
      return ownerId;
    },
    setOwnerId(value: string) {
      ownerId = value;
    }
  };
}

function createdAsset(ownerId: string) {
  return {
    asset: {
      id: "asset-opaque-1",
      ownerService: "hhc-line-function-bot",
      ownerType: "assurance_probe",
      ownerId,
      visibility: "restricted" as const,
      uploadStatus: "created" as const,
      scanStatus: "pending" as const
    },
    uploadTarget: {
      url: "https://blob.invalid/private-sas",
      method: "PUT",
      headers: { "x-secret": "upload-secret" }
    }
  };
}

function pendingAsset(ownerId: string): AssetRecord {
  return {
    ...owner(ownerId),
    id: "asset-opaque-1",
    uploadStatus: "completed",
    scanStatus: "pending",
    sizeBytes: 20,
    checksumSha256: CHECKSUM,
    detectedMimeType: "text/plain"
  };
}

function cleanAsset(ownerId: string): AssetRecord {
  return {
    ...pendingAsset(ownerId),
    scanStatus: "clean",
    scanSignatureVersion: "main-opaque"
  };
}

function owner(
  ownerId: string
): Pick<AssetRecord, "ownerService" | "ownerType" | "ownerId" | "visibility"> {
  return {
    ownerService: "hhc-line-function-bot",
    ownerType: "assurance_probe",
    ownerId,
    visibility: "restricted"
  };
}
