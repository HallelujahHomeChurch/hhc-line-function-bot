import { describe, expect, it, vi } from "vitest";

import { createPublicPageReader } from "../clients/public-page.js";

const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 }];

describe("public page reader", () => {
  it("extracts bounded text and direct score links from untrusted HTML", async () => {
    const request = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: new TextEncoder().encode(
        '<html><head><script>ignore me</script></head><body><h1>Choir score</h1><a href="/score.pdf">Download PDF</a></body></html>'
      )
    }));
    const reader = createPublicPageReader({
      maxBytes: 1024,
      maxRedirects: 1,
      request,
      resolve: resolvePublic,
      timeoutMs: 1000
    });

    await expect(reader.read("https://scores.example.test/page")).resolves.toEqual({
      kind: "html",
      untrusted: true,
      text: "Choir score Download PDF",
      links: [{ title: "Download PDF", url: "https://scores.example.test/score.pdf" }]
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects private targets before issuing a request", async () => {
    const request = vi.fn();
    const reader = createPublicPageReader({
      maxBytes: 1024,
      maxRedirects: 0,
      request,
      timeoutMs: 1000
    });

    await expect(reader.read("https://127.0.0.1/private")).rejects.toThrow(
      "external_binary_unsafe_address"
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared response before parsing page content", async () => {
    const reader = createPublicPageReader({
      maxBytes: 1024,
      maxRedirects: 0,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { "content-type": "text/html", "content-length": "2048" },
        body: new TextEncoder().encode("small partial body")
      })),
      resolve: resolvePublic,
      timeoutMs: 1000
    });

    await expect(reader.read("https://scores.example.test/page")).rejects.toThrow(
      "public_page_too_large"
    );
  });

  it("revalidates every redirect before another request", async () => {
    const request = vi.fn(async () => ({
      statusCode: 302,
      headers: { location: "https://127.0.0.1/private" },
      body: new Uint8Array()
    }));
    const reader = createPublicPageReader({
      maxBytes: 1024,
      maxRedirects: 1,
      request,
      resolve: resolvePublic,
      timeoutMs: 1000
    });

    await expect(reader.read("https://scores.example.test/page")).rejects.toThrow(
      "external_binary_unsafe_address"
    );
    expect(request).toHaveBeenCalledOnce();
  });
});
