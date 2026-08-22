import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { runReleaseProbe } from "../assurance/release-probe.js";
import { runReleaseProbeCli } from "../tools/run-release-probe.js";

const now = new Date("2026-07-27T00:00:00.000Z");
const mainEmptyWebhookSignature = createHmac("sha256", "main-channel-secret")
  .update('{"events":[]}')
  .digest("base64");
const input = {
  botBaseUrl: "http://bot.internal",
  searxngBaseUrl: "http://searxng.internal",
  gatewayWebhookUrl: "https://gateway.invalid/api/line/webhook/helper",
  gatewayMainWebhookUrl: "https://gateway.invalid/api/line/webhook/main",
  lineHelperChannelSecret: "test-channel-secret",
  lineMainEmptyWebhookSignature: mainEmptyWebhookSignature
};

function dependencies(fetchImpl: typeof fetch) {
  return { fetch: fetchImpl };
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
        { name: "gateway_helper_signed_empty_webhook", status: "passed", code: "none" },
        { name: "gateway_main_signed_empty_webhook", status: "passed", code: "none" }
      ]
    });
    expect(requests).toHaveLength(5);
    expect(requests.map((request) => request.url)).not.toContainEqual(
      expect.stringMatching(/deepseek|embedding/u)
    );
    const helperWebhook = requests.find((request) => request.url === input.gatewayWebhookUrl);
    expect(helperWebhook).toMatchObject({
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
    const mainWebhook = requests.find((request) => request.url === input.gatewayMainWebhookUrl);
    expect(mainWebhook).toMatchObject({
      url: input.gatewayMainWebhookUrl,
      init: {
        method: "POST",
        body: '{"events":[]}',
        headers: {
          "content-type": "application/json",
          "x-line-signature": mainEmptyWebhookSignature
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain(mainEmptyWebhookSignature);
  });

  it.each([
    ["malformed", "not-base64"],
    ["short", Buffer.alloc(31).toString("base64")],
    ["long", Buffer.alloc(33).toString("base64")]
  ])("rejects a %s derived main signature before any request", async (_reason, signature) => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await expect(
      runReleaseProbe({ ...input, lineMainEmptyWebhookSignature: signature }, dependencies(fetch))
    ).rejects.toThrow("release_probe_invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "helper",
      input.gatewayWebhookUrl,
      "gateway_helper_signed_empty_webhook" as const,
      307,
      createHmac("sha256", input.lineHelperChannelSecret).update('{"events":[]}').digest("base64")
    ],
    [
      "main",
      input.gatewayMainWebhookUrl,
      "gateway_main_signed_empty_webhook" as const,
      308,
      mainEmptyWebhookSignature
    ]
  ])(
    "rejects a redirected %s webhook without forwarding its signature",
    async (_profile, webhookUrl, checkName, status, signature) => {
      const redirectUrl = "https://redirect.invalid/collect";
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url);
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/healthz")) {
          return Response.json({ ok: true, service: "hhc-line-function-bot" });
        }
        if (requestUrl.endsWith("/readyz")) {
          return Response.json({
            status: "ok",
            database: { postgres: { status: "ok" }, redis: { status: "ok" } }
          });
        }
        if (requestUrl === "http://searxng.internal/") {
          return new Response(null, { status: 200 });
        }
        if (requestUrl === webhookUrl) {
          return new Response(null, { status, headers: { location: redirectUrl } });
        }
        return Response.json({ ok: true, ignored: true });
      }) as unknown as typeof globalThis.fetch;

      const result = await runReleaseProbe(input, dependencies(fetch));

      expect(result.checks).toContainEqual({
        name: checkName,
        status: "failed",
        code: "http_mismatch"
      });
      expect(requests.filter((request) => request.url === webhookUrl)).toHaveLength(1);
      expect(requests.some((request) => request.url === redirectUrl)).toBe(false);
      expect(requests.find((request) => request.url === webhookUrl)?.init).toMatchObject({
        redirect: "error",
        headers: { "x-line-signature": signature }
      });
    }
  );

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
        GATEWAY_MAIN_WEBHOOK_URL: input.gatewayMainWebhookUrl,
        LINE_HELPER_CHANNEL_SECRET: input.lineHelperChannelSecret,
        LINE_MAIN_EMPTY_WEBHOOK_SIGNATURE: input.lineMainEmptyWebhookSignature
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
    expect(output).not.toContain(input.lineMainEmptyWebhookSignature);
  });
});
