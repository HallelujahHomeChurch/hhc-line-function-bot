import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetApiClient } from "../clients/asset-api.js";
import { MeetingWindowClient } from "../media-sync/meeting-client.js";

afterEach(() => vi.unstubAllEnvs());

describe("production internal caller origins", () => {
  it("constructs token-free private HTTPS clients without audience metadata", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      createAssetApiClient({
        baseUrl: "https://asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io"
      })
    ).not.toThrow();
    expect(
      () =>
        new MeetingWindowClient({
          baseUrl:
            "https://operations-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io"
        })
    ).not.toThrow();
  });
  it.each([
    "https://foreign.example",
    "http://127.0.0.1:3500",
    "https://asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io.evil.example",
    "https://user@asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io",
    "https://asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io/path"
  ])("rejects production caller origin %s", (baseUrl) => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createAssetApiClient({ baseUrl })).toThrow("private HTTPS origin");
    expect(() => new MeetingWindowClient({ baseUrl })).toThrow("private HTTPS origin");
  });
});
