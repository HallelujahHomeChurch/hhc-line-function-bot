import { describe, expect, it, vi } from "vitest";

import { signLineBody } from "../line-signature.js";
import { createApp } from "../server.js";
import type { AppConfig, AppDiagnostics, FunctionRouterPort, LineReplyClient } from "../types.js";

function config(): AppConfig {
  return {
    serviceName: "hhc-line-function-bot",
    host: "127.0.0.1",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    readyPath: "/readyz",
    maxBodyBytes: 32_768,
    profiles: [
      {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "helper-secret",
        channelAccessToken: "helper-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: false,
        wakeKeywords: [],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "query_schedule"],
        adminUserId: "Uadmin",
        adminDirectOnly: true,
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed",
        registration: { enabled: true }
      }
    ],
    llm: {
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000
    }
  };
}

function diagnostics(status: "ok" | "error" = "ok"): AppDiagnostics {
  return {
    checkPublicReadiness: vi.fn().mockResolvedValue({
      service: "hhc-line-function-bot",
      status,
      database: {
        postgres: { configured: true, status, latencyMs: 12 },
        redis: { configured: true, status, latencyMs: 8 }
      }
    }),
    formatAdminDiagnostics: vi
      .fn()
      .mockResolvedValue(
        [
          "Diagnostics",
          "profiles: helper",
          "functions: find_ppt_slides, query_schedule",
          "postgres: ok",
          "redis: ok",
          "deepseek: ok",
          "graph: configured",
          "notion: configured"
        ].join("\n")
      )
  };
}

function lineBody(event: Record<string, unknown>) {
  return JSON.stringify({ destination: "bot", events: [event] });
}

function signedHeaders(body: string) {
  return {
    "content-type": "application/json",
    "x-line-signature": signLineBody(Buffer.from(body), "helper-secret")
  };
}

describe("diagnostics", () => {
  it("keeps healthz minimal", async () => {
    const app = createApp(config(), {
      router: { route: vi.fn() },
      diagnostics: diagnostics()
    });

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      service: "hhc-line-function-bot"
    });
    expect(res.json()).toHaveProperty("timestamp");
    expect(res.json()).not.toHaveProperty("profiles");
    expect(res.json()).not.toHaveProperty("llm");
    expect(res.json()).not.toHaveProperty("timeZone");
  });

  it("exposes only Postgres and Redis from readyz", async () => {
    const app = createApp(config(), {
      router: { route: vi.fn() },
      diagnostics: diagnostics()
    });

    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      service: "hhc-line-function-bot",
      status: "ok",
      database: {
        postgres: { configured: true, status: "ok", latencyMs: 12 },
        redis: { configured: true, status: "ok", latencyMs: 8 }
      }
    });
    expect(res.body).not.toContain("deepseek");
    expect(res.body).not.toContain("graph");
    expect(res.body).not.toContain("notion");
    expect(res.body).not.toContain("profiles");
    expect(res.body).not.toContain("enabledFunctions");
  });

  it("returns 503 from readyz when the data layer is not ready", async () => {
    const app = createApp(config(), {
      router: { route: vi.fn() },
      diagnostics: diagnostics("error")
    });

    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("shows detailed diagnostics only to direct admin users", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const appDiagnostics = diagnostics();
    const app = createApp(config(), {
      router: { route },
      diagnostics: appDiagnostics,
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/diag" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(appDiagnostics.formatAdminDiagnostics).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("Diagnostics"),
      undefined
    );
  });

  it("blocks diag from non-admin users", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const appDiagnostics = diagnostics();
    const app = createApp(config(), {
      router: { route },
      diagnostics: appDiagnostics,
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Unotadmin" },
      message: { type: "text", text: "/diag" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(appDiagnostics.formatAdminDiagnostics).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith("reply-token", expect.any(String), undefined);
  });
});
