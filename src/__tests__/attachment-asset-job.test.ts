import { describe, expect, it } from "vitest";

import {
  assetAccessTokenScope,
  readAttachmentAssetJobEnvironment
} from "../tools/run-attachment-asset-job.js";

describe("attachment asset job environment", () => {
  it("requires one dedicated managed identity and private Asset endpoint", () => {
    expect(
      readAttachmentAssetJobEnvironment({
        ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/line-attachment-scan",
        ASSET_API_URL: "https://asset-api.internal.example",
        ASSET_API_AUDIENCE: "api://asset-api",
        AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111"
      })
    ).toEqual({
      queueUrl: "https://assetscan.queue.core.windows.net/line-attachment-scan",
      assetApiUrl: "https://asset-api.internal.example",
      assetApiAudience: "api://asset-api",
      managedIdentityClientId: "11111111-1111-4111-8111-111111111111"
    });
  });

  it.each([
    ["ATTACHMENT_SCAN_QUEUE_URL", { ATTACHMENT_SCAN_QUEUE_URL: "http://queue.invalid" }],
    ["ASSET_API_URL", { ASSET_API_URL: "http://asset.invalid" }],
    ["ASSET_API_AUDIENCE", { ASSET_API_AUDIENCE: "asset-api" }],
    ["AZURE_CLIENT_ID", { AZURE_CLIENT_ID: "not-a-uuid" }]
  ])("rejects an invalid %s", (field, override) => {
    expect(() =>
      readAttachmentAssetJobEnvironment({
        ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/line-attachment-scan",
        ASSET_API_URL: "https://asset-api.internal.example",
        ASSET_API_AUDIENCE: "api://asset-api",
        AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
        ...override
      })
    ).toThrow(field);
  });

  it("uses the application scope required by managed identity", () => {
    expect(assetAccessTokenScope("api://asset-api")).toBe("api://asset-api/.default");
  });
});
