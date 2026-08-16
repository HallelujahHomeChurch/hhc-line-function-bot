import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAssetApiClient,
  isAssetAccessDeniedError,
  isTransientAssetApiError
} from "../clients/asset-api.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("asset api client", () => {
  it("uses exact Dapr management paths, request IDs, and idempotency keys", async () => {
    const collection = {
      id: "collection-1",
      namespace: "line.group.media-sync",
      name: "Media",
      revision: 1,
      createdAt: "2026-08-16T00:00:00Z",
      updatedAt: "2026-08-16T00:00:00Z"
    };
    const acl = {
      id: "acl-1",
      collectionId: "collection-1",
      subjectType: "user",
      subjectId: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
      permission: "read",
      createdAt: "2026-08-16T00:00:00Z"
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ collections: [{ collection, acls: [] }], hasMore: false })
      )
      .mockResolvedValueOnce(jsonResponse({ collection, acls: [] }))
      .mockResolvedValueOnce(jsonResponse(collection, 201))
      .mockResolvedValueOnce(jsonResponse({ ...collection, name: "Renamed", revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ ...collection, deletedAt: "2026-08-16T01:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ collection: { ...collection, revision: 2 }, acl }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          collection: { ...collection, revision: 3 },
          acl: { ...acl, revokedAt: "2026-08-16T01:00:00Z" }
        })
      );
    const client = createAssetApiClient({
      baseUrl: "http://127.0.0.1:3500/v1.0/invoke/asset-api/method",
      timeoutMs: 1000,
      fetcher
    });

    await client.listManagedCollections({ cursor: "cursor-1", limit: 25 }, { requestId: "req-1" });
    await client.getManagedCollection("collection-1", { requestId: "req-2" });
    await client.createCollection("Media", "create-1", { requestId: "req-3" });
    await client.renameCollection("collection-1", "Renamed", "rename-1", {
      requestId: "req-4"
    });
    await client.deleteCollection("collection-1", "delete-1", { requestId: "req-5" });
    await client.addCollectionAcl(
      "collection-1",
      { subjectType: "user", subjectId: acl.subjectId },
      "acl-add-1",
      { requestId: "req-6" }
    );
    await client.revokeCollectionAcl("collection-1", "acl-1", "acl-delete-1", {
      requestId: "req-7"
    });

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3500/v1.0/invoke/asset-api/method/priv/assets/collections?cursor=cursor-1&limit=25",
      "http://127.0.0.1:3500/v1.0/invoke/asset-api/method/priv/assets/collections/collection-1",
      "http://127.0.0.1:3500/v1.0/invoke/asset-api/method/priv/assets/collections",
      "http://127.0.0.1:3500/v1.0/invoke/asset-api/method/priv/assets/collections/collection-1",
      "http://127.0.0.1:3500/v1.0/invoke/asset-api/method/priv/assets/collections/collection-1",
      "http://127.0.0.1:3500/v1.0/invoke/asset-api/method/priv/assets/collections/collection-1/acl",
      "http://127.0.0.1:3500/v1.0/invoke/asset-api/method/priv/assets/collections/collection-1/acl/acl-1"
    ]);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers)).toEqual(expect.objectContaining({}));
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-hhc-request-id")).toBe("req-1");
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("idempotency-key")).toBe(
      "create-1"
    );
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      namespace: "line.group.media-sync",
      name: "Media"
    });
  });

  it("rejects malformed managed collection responses without leaking their body", async () => {
    const client = createAssetApiClient({
      baseUrl: "http://asset-api",
      timeoutMs: 1000,
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ collections: [], items: [] }))
    });

    const error = await client.listManagedCollections().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "asset_api_invalid_response"
    });
    expect(String(error)).not.toContain("items");
  });

  it("times out Dapr management calls with a secret-safe transient error", async () => {
    const client = createAssetApiClient({
      baseUrl: "http://asset-api",
      timeoutMs: 1,
      fetcher: vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("upstream secret timeout detail"))
            );
          })
      )
    });

    const error = await client.listManagedCollections().catch((caught: unknown) => caught);

    expect(isTransientAssetApiError(error)).toBe(true);
    expect(String(error)).not.toContain("upstream secret");
  });

  it("normalizes Go zero lifecycle timestamps on live collections and ACLs", async () => {
    const client = createAssetApiClient({
      baseUrl: "http://asset-api",
      timeoutMs: 1000,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          collection: {
            id: "collection-1",
            namespace: "line.group.media-sync",
            name: "Media",
            revision: 1,
            createdAt: "2026-08-16T00:00:00Z",
            updatedAt: "2026-08-16T00:00:00Z",
            deletedAt: "0001-01-01T00:00:00Z"
          },
          acls: [
            {
              id: "acl-1",
              collectionId: "collection-1",
              subjectType: "role",
              subjectId: "media_sync_user",
              permission: "read",
              createdAt: "2026-08-16T00:00:00Z",
              revokedAt: "0001-01-01T00:00:00Z"
            }
          ]
        })
      )
    });

    await expect(client.getManagedCollection("collection-1")).resolves.toEqual({
      collection: {
        id: "collection-1",
        namespace: "line.group.media-sync",
        name: "Media",
        revision: 1,
        createdAt: "2026-08-16T00:00:00Z",
        updatedAt: "2026-08-16T00:00:00Z"
      },
      acls: [
        {
          id: "acl-1",
          collectionId: "collection-1",
          subjectType: "role",
          subjectId: "media_sync_user",
          permission: "read",
          createdAt: "2026-08-16T00:00:00Z"
        }
      ]
    });
  });

  it("uses one workload token and deterministic idempotency keys for the asset lifecycle", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            asset: { id: "asset-1", uploadStatus: "created", scanStatus: "pending" },
            session: { status: "created" },
            uploadTarget: {
              url: "https://blob/upload",
              method: "PUT",
              headers: { "x-ms-blob-type": "BlockBlob" }
            }
          },
          201
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "asset-1", uploadStatus: "completed", scanStatus: "pending" })
      )
      .mockResolvedValueOnce(jsonResponse({ id: "grant-1" }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "asset-1",
          uploadStatus: "completed",
          scanStatus: "clean",
          scanSignatureVersion: "main-1"
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/pdf" }
        })
      );
    const client = createAssetApiClient({
      baseUrl: "https://asset.internal",
      getAccessToken: vi.fn().mockResolvedValue("token"),
      fetcher
    });

    const created = await client.createUpload({
      idempotencyKey: "line-attachment:work-1",
      ownerType: "line_message",
      ownerId: "line-1",
      purpose: "resource",
      fileName: "weekly.pdf",
      mimeType: "application/pdf",
      maxSizeBytes: 1024
    });
    await client.upload(created.uploadTarget!, new Uint8Array([1, 2, 3]));
    await client.complete("asset-1", {
      sizeBytes: 3,
      checksumSha256: "abc",
      mimeType: "application/pdf"
    });
    await client.grantServiceRead("asset-1", "line-attachment-read:work-1");
    await client.get("asset-1");
    await client.download("asset-1");

    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer token",
        "idempotency-key": "line-attachment:work-1"
      })
    });
    expect(fetcher.mock.calls[1]).toEqual([
      "https://blob/upload",
      expect.objectContaining({ method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" } })
    ]);
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "line-attachment-read:work-1" })
    });
    expect(fetcher.mock.calls[5]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        "x-asset-subject-type": "service",
        "x-asset-subject-id": "hhc-line-function-bot"
      })
    });
  });

  it.each([429, 500, 503])("classifies Asset HTTP %s as transient", async (status) => {
    const client = createAssetApiClient({
      baseUrl: "https://asset.internal",
      getAccessToken: vi.fn().mockResolvedValue("token"),
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
    });

    const error = await client
      .get("asset-1")
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(isTransientAssetApiError(error)).toBe(true);
  });

  it("classifies timeouts as transient without leaking provider details", async () => {
    const client = createAssetApiClient({
      baseUrl: "https://asset.internal",
      getAccessToken: vi.fn().mockResolvedValue("token"),
      fetcher: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("timed out", "TimeoutError"))
    });

    const error = await client
      .get("asset-1")
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(isTransientAssetApiError(error)).toBe(true);
    expect(String(error)).not.toContain("timed out");
  });

  it.each([400, 401, 403, 404])("classifies Asset HTTP %s as permanent", async (status) => {
    const client = createAssetApiClient({
      baseUrl: "https://asset.internal",
      getAccessToken: vi.fn().mockResolvedValue("token"),
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
    });

    const error = await client
      .get("asset-1")
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(isTransientAssetApiError(error)).toBe(false);
  });

  it("rejects an invalid Asset response as permanent", async () => {
    const client = createAssetApiClient({
      baseUrl: "https://asset.internal",
      getAccessToken: vi.fn().mockResolvedValue("token"),
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ id: "asset-1", uploadStatus: "completed", scanStatus: "unknown" })
        )
    });

    const error = await client
      .get("asset-1")
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(isTransientAssetApiError(error)).toBe(false);
  });

  it("returns owner and grant identity for exact revoke and soft-delete cleanup", async () => {
    const signal = AbortSignal.timeout(1_000);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            asset: {
              id: "asset-1",
              ownerService: "hhc-line-function-bot",
              ownerType: "assurance_probe",
              ownerId: "asset-assurance:run-1",
              visibility: "restricted",
              uploadStatus: "created",
              scanStatus: "pending"
            },
            uploadTarget: {
              url: "https://blob.invalid/upload-secret",
              method: "PUT",
              headers: { "x-ms-blob-type": "BlockBlob" }
            }
          },
          201
        )
      )
      .mockResolvedValueOnce(jsonResponse({ id: "grant-1" }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "asset-1",
          ownerService: "hhc-line-function-bot",
          ownerType: "assurance_probe",
          ownerId: "asset-assurance:run-1",
          visibility: "restricted",
          uploadStatus: "completed",
          scanStatus: "clean"
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const getAccessToken = vi.fn().mockResolvedValue("workload-token");
    const client = createAssetApiClient({
      baseUrl: "https://asset.internal",
      getAccessToken,
      fetcher
    });

    const created = await client.createUpload(
      {
        idempotencyKey: "asset-assurance:run-1",
        ownerType: "assurance_probe",
        ownerId: "asset-assurance:run-1",
        purpose: "assurance",
        fileName: "asset-assurance.txt",
        mimeType: "text/plain",
        maxSizeBytes: 64
      },
      { signal }
    );
    const grant = await client.grantServiceRead("asset-1", "asset-assurance-read:run-1", {
      signal
    });
    await client.revokeGrant("asset-1", grant.id, { signal });
    const owned = await client.get("asset-1", { signal });
    await client.softDelete("asset-1", { signal });
    const denied = await client
      .download("asset-1", { signal })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(created.asset).toMatchObject({
      ownerService: "hhc-line-function-bot",
      ownerType: "assurance_probe",
      ownerId: "asset-assurance:run-1",
      visibility: "restricted"
    });
    expect(grant).toEqual({ id: "grant-1" });
    expect(owned.ownerId).toBe("asset-assurance:run-1");
    expect(isAssetAccessDeniedError(denied)).toBe(true);
    expect(getAccessToken).toHaveBeenCalledWith(signal);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      signal,
      body: JSON.stringify({
        namespace: "line.group.file",
        ownerService: "hhc-line-function-bot",
        ownerType: "assurance_probe",
        ownerId: "asset-assurance:run-1",
        purpose: "assurance",
        originalFileName: "asset-assurance.txt",
        expectedMimeType: "text/plain",
        maxSizeBytes: 64,
        visibility: "restricted"
      })
    });
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "https://asset.internal/priv/assets/asset-1/grants/grant-1"
    );
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE", signal });
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ method: "DELETE", signal });
  });

  it("uses the media-sync namespace and returns the actual collection occurrence", async () => {
    const collection = liveCollection(2);
    const item = liveCollectionItem();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            asset: {
              id: "asset-1",
              etag: "etag-1",
              uploadStatus: "created",
              scanStatus: "pending",
              processingStatus: "pending"
            },
            uploadTarget: {
              url: "https://blob.invalid/opaque",
              method: "PUT",
              headers: { "x-ms-blob-type": "BlockBlob" }
            }
          },
          201
        )
      )
      .mockResolvedValueOnce(jsonResponse({ collection, item }, 201))
      .mockResolvedValueOnce(jsonResponse({ collection: liveCollection(3), item }));
    const client = createAssetApiClient({ baseUrl: "https://asset.internal", fetcher });

    const created = await client.createUpload({
      namespace: "line.group.media-sync",
      idempotencyKey: "media-sync-upload-1",
      ownerType: "line_group",
      ownerId: "group-1",
      purpose: "media-sync",
      fileName: "video.mp4",
      mimeType: "video/mp4",
      maxSizeBytes: 209_715_200
    });
    const mutation = await client.addCollectionItem(
      "collection-1",
      {
        assetId: "asset-1",
        remoteItemId: "line:helper:message-1",
        displayName: "video.mp4",
        sourceRevision: "checksum-1"
      },
      "media-sync-membership-1"
    );
    await client.deleteCollectionItem(
      "collection-1",
      "occurrence-actual-1",
      "media-sync-membership-delete-1"
    );

    expect(created.asset).toMatchObject({ etag: "etag-1", processingStatus: "pending" });
    expect(mutation.item.id).toBe("occurrence-actual-1");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      namespace: "line.group.media-sync",
      ownerService: "hhc-line-function-bot",
      ownerType: "line_group",
      ownerId: "group-1",
      purpose: "media-sync"
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://asset.internal/priv/assets/collections/collection-1/items"
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      assetId: "asset-1",
      remoteItemId: "line:helper:message-1",
      displayName: "video.mp4",
      sourceRevision: "checksum-1"
    });
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "https://asset.internal/priv/assets/collections/collection-1/items/occurrence-actual-1"
    );
  });

  it("rejects malformed or widened collection item mutation responses", async () => {
    const malformed = createAssetApiClient({
      baseUrl: "https://asset.internal",
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ collection: liveCollection(2), item: { id: "alias" } }))
    });
    await expect(
      malformed.addCollectionItem(
        "collection-1",
        {
          assetId: "asset-1",
          remoteItemId: "line:helper:message-1",
          displayName: "video.mp4",
          sourceRevision: "checksum-1"
        },
        "key-1"
      )
    ).rejects.toThrow("asset_api_invalid_response");

    const widened = createAssetApiClient({
      baseUrl: "https://asset.internal",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          collection: liveCollection(2),
          item: liveCollectionItem(),
          internalBlobKey: "must-not-leak"
        })
      )
    });
    await expect(
      widened.addCollectionItem(
        "collection-1",
        {
          assetId: "asset-1",
          remoteItemId: "line:helper:message-1",
          displayName: "video.mp4",
          sourceRevision: "checksum-1"
        },
        "key-2"
      )
    ).rejects.toThrow("asset_api_invalid_response");
  });

  it("streams a temporary file to the signed upload target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hhc-asset-upload-test-"));
    tempDirectories.push(directory);
    const filePath = join(directory, "content.bin");
    await writeFile(filePath, Buffer.from("streamed-content"));
    let body = Buffer.alloc(0);
    const server = createServer((request, response) => {
      request.on("data", (chunk) => {
        body = Buffer.concat([body, Buffer.from(chunk)]);
      });
      request.on("end", () => {
        expect(request.method).toBe("PUT");
        expect(request.headers["x-upload-token"]).toBe("opaque");
        response.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_unavailable");

    try {
      await createAssetApiClient({
        baseUrl: "https://asset.internal",
        fetcher: vi.fn<typeof fetch>()
      }).uploadFile(
        {
          url: `http://127.0.0.1:${address.port}/upload`,
          method: "PUT",
          headers: { "x-upload-token": "opaque" }
        },
        filePath
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    expect(body.toString()).toBe("streamed-content");
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function liveCollection(revision: number) {
  return {
    id: "collection-1",
    namespace: "line.group.media-sync",
    name: "Media",
    revision,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:01:00Z"
  };
}

function liveCollectionItem() {
  return {
    id: "occurrence-actual-1",
    collectionId: "collection-1",
    assetId: "asset-1",
    remoteItemId: "line:helper:message-1",
    displayName: "video.mp4",
    sourceRevision: "checksum-1",
    createdRevision: 2,
    mimeType: "video/mp4",
    sizeBytes: 5,
    etag: "etag-1",
    createdAt: "2026-08-16T00:01:00Z"
  };
}
