import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { runReleaseProbe } from "../assurance/release-probe.js";
import { runReleaseProbeCli } from "../tools/run-release-probe.js";

const now = new Date("2026-07-27T00:00:00.000Z");
const input = {
  botBaseUrl: "http://bot.internal",
  searxngBaseUrl: "http://searxng.internal",
  gatewayWebhookUrl: "https://gateway.invalid/api/line/webhook/helper",
  lineHelperChannelSecret: "test-channel-secret",
  clamavSignatureManifestPath: "/mnt/signatures/manifest.json"
};

function currentManifest(lastSuccessfulAt = "2026-07-26T23:00:00.000Z") {
  return JSON.stringify({
    version: 1,
    signatureVersion: "current",
    lastSuccessfulAt,
    databaseDirectory: "sets/current"
  });
}

function dependencies(fetchImpl: typeof fetch, manifest = currentManifest()) {
  return {
    fetch: fetchImpl,
    readFile: vi.fn().mockResolvedValue(manifest),
    now: () => now
  };
}

describe("runReleaseProbe", () => {
  it("passes the provider-free release gates and returns only allowlisted observations", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/healthz")) {
        return Response.json({
          ok: true,
          service: "hhc-line-function-bot",
          timestamp: now.toISOString()
        });
      }
      if (String(url).endsWith("/readyz")) {
        return Response.json({
          service: "hhc-line-function-bot",
          status: "ok",
          database: {
            postgres: { configured: true, status: "ok", latencyMs: 1 },
            redis: { configured: true, status: "ok", latencyMs: 1 }
          }
        });
      }
      if (String(url) === "http://searxng.internal/") {
        return new Response(null, { status: 302, headers: { location: "/search" } });
      }
      return Response.json({ ok: true, ignored: true });
    }) as unknown as typeof fetch;

    const result = await runReleaseProbe(input, dependencies(fetch));

    expect(result).toEqual({
      status: "passed",
      checks: [
        { name: "bot_health", status: "passed", code: "none" },
        { name: "bot_readiness", status: "passed", code: "none" },
        { name: "searxng_root", status: "passed", code: "none" },
        { name: "gateway_empty_webhook", status: "passed", code: "none" },
        {
          name: "clamav_signature",
          status: "passed",
          code: "none",
          signatureHealth: "current"
        }
      ]
    });
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.url)).not.toContainEqual(
      expect.stringMatching(/deepseek|embedding/u)
    );
    const webhook = requests.at(-1);
    expect(webhook).toMatchObject({
      url: input.gatewayWebhookUrl,
      init: {
        method: "POST",
        body: '{"events":[]}',
        headers: {
          "content-type": "application/json",
          "x-line-signature": createHmac("sha256", input.lineHelperChannelSecret)
            .update('{"events":[]}')
            .digest("base64")
        }
      }
    });
  });

  it("keeps a usable old ClamAV signature manifest as a warning rather than failing", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/healthz")) {
        return Response.json({ ok: true, service: "hhc-line-function-bot" });
      }
      if (String(url).endsWith("/readyz")) {
        return Response.json({
          status: "ok",
          database: { postgres: { status: "ok" }, redis: { status: "ok" } }
        });
      }
      if (String(url) === "http://searxng.internal/") return new Response(null, { status: 200 });
      return Response.json({ ok: true, ignored: true });
    }) as unknown as typeof fetch;
    const result = await runReleaseProbe(
      input,
      dependencies(fetch, currentManifest("2026-07-19T00:00:00.000Z"))
    );

    expect(result.checks.at(-1)).toEqual({
      name: "clamav_signature",
      status: "warning",
      code: "signature_warning",
      signatureHealth: "warning"
    });
    expect(result.status).toBe("passed");
  });

  it.each([
    ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError")), "timeout"],
    ["HTTP mismatch", () => Promise.resolve(new Response(null, { status: 503 })), "http_mismatch"],
    ["malformed JSON", () => Promise.resolve(new Response("not json")), "malformed_json"],
    ["network failure", () => Promise.reject(new Error("offline")), "network_failed"]
  ])("reports %s without raw endpoint output", async (_reason, response, code) => {
    const fetch = vi.fn(response) as unknown as typeof globalThis.fetch;
    const result = await runReleaseProbe(input, dependencies(fetch));

    expect(result.status).toBe("failed");
    expect(result.checks).toContainEqual({ name: "bot_health", status: "failed", code });
    expect(JSON.stringify(result)).not.toContain(input.botBaseUrl);
  });

  it.each([
    ["invalid", "{}"],
    ["future", currentManifest("2026-07-27T00:00:01.000Z")]
  ])("fails an %s ClamAV manifest", async (_reason, manifest) => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/healthz")) {
        return Response.json({ ok: true, service: "hhc-line-function-bot" });
      }
      if (String(url).endsWith("/readyz")) {
        return Response.json({
          status: "ok",
          database: { postgres: { status: "ok" }, redis: { status: "ok" } }
        });
      }
      if (String(url) === "http://searxng.internal/") return new Response(null, { status: 200 });
      return Response.json({ ok: true, ignored: true });
    }) as unknown as typeof fetch;

    const result = await runReleaseProbe(input, dependencies(fetch, manifest));

    expect(result.status).toBe("failed");
    expect(result.checks.at(-1)).toEqual({
      name: "clamav_signature",
      status: "failed",
      code: "clamav_manifest_invalid"
    });
  });

  it("prints one allowlisted result and returns a failing exit code for a failed required check", async () => {
    const writeLine = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/healthz")) return new Response(null, { status: 503 });
      if (String(url).endsWith("/readyz")) {
        return Response.json({
          status: "ok",
          database: { postgres: { status: "ok" }, redis: { status: "ok" } }
        });
      }
      if (String(url) === "http://searxng.internal/") return new Response(null, { status: 200 });
      return Response.json({ ok: true, ignored: true });
    }) as unknown as typeof fetch;

    const exitCode = await runReleaseProbeCli(
      {
        BOT_BASE_URL: input.botBaseUrl,
        SEARXNG_BASE_URL: input.searxngBaseUrl,
        GATEWAY_WEBHOOK_URL: input.gatewayWebhookUrl,
        LINE_HELPER_CHANNEL_SECRET: input.lineHelperChannelSecret,
        CLAMAV_SIGNATURE_MANIFEST_PATH: input.clamavSignatureManifestPath
      },
      dependencies(fetch),
      writeLine
    );

    expect(exitCode).toBe(1);
    expect(writeLine).toHaveBeenCalledOnce();
    const output = writeLine.mock.calls[0]?.[0] ?? "";
    expect(JSON.parse(output)).toMatchObject({
      status: "failed",
      checks: expect.arrayContaining([
        { name: "bot_health", status: "failed", code: "http_mismatch" }
      ])
    });
    expect(output).not.toContain(input.lineHelperChannelSecret);
  });
});
