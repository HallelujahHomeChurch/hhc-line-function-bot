import { beforeEach, expect, it, vi } from "vitest";
import { ManagedIdentityCredential } from "@azure/identity";
import { createAssetApiClient } from "../clients/asset-api.js";
import { readAssetWorkloadAuth } from "../clients/asset-workload.js";

vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: vi.fn() }));
const getToken = vi.fn();
const workloadAuth = {
  audience: "api://asset-test",
  clientId: "11111111-1111-4111-8111-111111111111"
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ManagedIdentityCredential).mockImplementation(function () {
    return { getToken } as unknown as ManagedIdentityCredential;
  });
  getToken.mockResolvedValue({ token: "fixture.token", expiresOnTimestamp: Date.now() + 60000 });
});
it("defaults off and rejects incomplete or unsafe workload configuration", () => {
  expect(readAssetWorkloadAuth({})).toBeUndefined();
  expect(() => readAssetWorkloadAuth({ ASSET_WORKLOAD_AUTH_ENABLED: "typo" })).toThrow();
  expect(() => readAssetWorkloadAuth({ ASSET_WORKLOAD_AUTH_ENABLED: "true" })).toThrow();
  for (const baseUrl of [
    "http://asset.internal",
    "https://unreviewed.internal",
    "https://asset.internal/path",
    "https://user:pass@asset.internal"
  ]) {
    expect(() => createAssetApiClient({ baseUrl, workloadAuth })).toThrow();
  }
});
it("injects bounded workload credentials only on the fixed private API origin", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ id: "asset", uploadStatus: "completed", scanStatus: "clean" })
    );
  const client = createAssetApiClient({
    baseUrl: "https://asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io",
    workloadAuth,
    fetcher
  });
  await client.get("asset");
  expect(ManagedIdentityCredential).toHaveBeenCalledWith(workloadAuth.clientId);
  expect(getToken).toHaveBeenCalledWith(
    "api://asset-test/.default",
    expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
  );
  const init = fetcher.mock.calls[0][1]!;
  expect(new Headers(init.headers).get("x-hhc-workload-authorization")).toBe(
    "Bearer fixture.token"
  );
  expect(init.redirect).toBe("manual");
  await client.upload(
    {
      url: "https://blob.test/upload",
      method: "PUT",
      headers: {
        "X-HHC-Workload-Authorization": "Bearer echoed",
        Authorization: "echoed",
        "Dapr-Api-Token": "echoed",
        "x-ms-blob-type": "BlockBlob"
      }
    },
    new Uint8Array([1])
  );
  const upload = fetcher.mock.calls[1][1]!;
  expect(new Headers(upload.headers).get("authorization")).toBeNull();
  expect(new Headers(upload.headers).get("x-hhc-workload-authorization")).toBeNull();
  expect(new Headers(upload.headers).get("dapr-api-token")).toBeNull();
  expect(new Headers(upload.headers).get("x-ms-blob-type")).toBe("BlockBlob");
  expect(upload.redirect).toBe("manual");
  expect(getToken).toHaveBeenCalledTimes(1);
});
it("never sends a request or falls back when token acquisition fails or token is unusable", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createAssetApiClient({
    baseUrl: "https://asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io",
    workloadAuth,
    fetcher
  });
  getToken.mockRejectedValueOnce(new Error("sensitive identity failure"));
  await expect(client.get("asset")).rejects.toThrow("asset_api_unavailable");
  for (const token of [
    null,
    { token: "expired", expiresOnTimestamp: 1 },
    { token: "a\nb", expiresOnTimestamp: Date.now() + 60000 }
  ]) {
    getToken.mockResolvedValueOnce(token);
    await expect(client.get("asset")).rejects.toThrow("asset_api_unavailable");
  }
  expect(fetcher).not.toHaveBeenCalled();
});
