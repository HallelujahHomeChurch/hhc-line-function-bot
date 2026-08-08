import { describe, expect, it, vi } from "vitest";

import { createAssetApiClient, isTransientAssetApiError } from "../clients/asset-api.js";

describe("asset api client", () => {
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
      workId: "work-1",
      lineMessageId: "line-1",
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
    await client.grantServiceRead("asset-1", "work-1");
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
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
