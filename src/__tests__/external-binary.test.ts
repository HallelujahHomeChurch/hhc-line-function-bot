import { promises as dns } from "node:dns";

import { describe, expect, it, vi } from "vitest";

import {
  createExternalBinaryClient,
  validateExternalBinaryUrl
} from "../clients/external-binary.js";

describe("external binary URL policy", () => {
  it.each([
    "http://example.org/file.pdf",
    "https://user:pass@example.org/file.pdf",
    "https://127.0.0.1/file.pdf",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/file.pdf",
    "https://[fc00::1]/file.pdf"
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      validateExternalBinaryUrl(url, async () => [{ address: "93.184.216.34", family: 4 }])
    ).rejects.toThrow(/external_binary_/u);
  });

  it("rejects a public hostname when any DNS answer is private", async () => {
    const error = await validateExternalBinaryUrl("https://example.org/file.pdf", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 }
    ]).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "external_binary_unsafe_address",
      transient: false
    });
  });

  it("returns a validated public address for HTTPS", async () => {
    await expect(
      validateExternalBinaryUrl("https://example.org/file.pdf", async () => [
        { address: "93.184.216.34", family: 4 }
      ])
    ).resolves.toMatchObject({ hostname: "example.org", address: "93.184.216.34", family: 4 });
  });

  it("converts a raw external network failure to a transient unavailable contract", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockRejectedValueOnce(new Error("network detail"));
    const client = createExternalBinaryClient();

    try {
      await expect(
        client.download({
          url: "https://example.org/file.pdf",
          maxBytes: 1024,
          timeoutMs: 100,
          maxRedirects: 1
        })
      ).rejects.toMatchObject({
        code: "external_binary_unavailable",
        transient: true
      });
    } finally {
      lookup.mockRestore();
    }
  });
});
