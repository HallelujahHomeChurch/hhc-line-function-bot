import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpVirusScanner } from "../clients/virus-scan.js";

describe("HTTP virus scanner client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts file metadata and base64 content to the scanner endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "clean", detail: "ok" })
    });
    vi.stubGlobal("fetch", fetchMock);
    const scanner = createHttpVirusScanner({
      endpoint: "https://scanner.internal/scan",
      apiKey: "secret",
      timeoutMs: 5000
    });

    await expect(
      scanner.scan({
        data: new Uint8Array([1, 2, 3]),
        fileName: "週報.pdf",
        contentType: "application/pdf",
        sha256: "sha"
      })
    ).resolves.toEqual({ status: "clean", detail: "ok" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://scanner.internal/scan",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer secret"
        }),
        body: JSON.stringify({
          fileName: "週報.pdf",
          contentType: "application/pdf",
          sha256: "sha",
          dataBase64: "AQID"
        })
      })
    );
  });

  it("fails closed when the scanner endpoint is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const scanner = createHttpVirusScanner({
      endpoint: "https://scanner.internal/scan",
      timeoutMs: 5000
    });

    await expect(
      scanner.scan({
        data: new Uint8Array([1]),
        fileName: "file.pdf",
        contentType: "application/pdf",
        sha256: "sha"
      })
    ).resolves.toEqual({ status: "unavailable", detail: "http_503" });
  });
});
