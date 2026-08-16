import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { signLineBody } from "../line-signature.js";
import type { PostgresMediaSyncStore } from "../media-sync/store.js";
import { createTestApp } from "../testing/create-test-app.js";
import type { AppConfig, FunctionRouterPort } from "../types.js";

describe("LINE media-sync lifecycle", () => {
  it("tombstones an unsent helper group message before rate limit, dedupe, access, or routing", async () => {
    const tombstoneSource = vi.fn().mockResolvedValue(true);
    const rateCheck = vi.fn();
    const tryStart = vi.fn();
    const route = vi.fn<FunctionRouterPort["route"]>();
    const accessStore = new InMemoryAccessStore();
    const accessLookup = vi.spyOn(accessStore, "hasActivePrincipal");
    const app = createTestApp(config(), {
      accessStore,
      mediaSyncStore: { tombstoneSource } as unknown as PostgresMediaSyncStore,
      rateLimiter: { check: rateCheck },
      webhookEventStore: { tryStart },
      router: { route }
    });

    const response = await inject(app, "/api/line/webhook/helper", "helper-secret", {
      type: "unsend",
      webhookEventId: "unsend-event-1",
      source: { type: "group", groupId: "G-lifecycle" },
      unsend: { messageId: "message-actual-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(tombstoneSource).toHaveBeenCalledWith("line:helper:message-actual-1");
    expect(rateCheck).not.toHaveBeenCalled();
    expect(tryStart).not.toHaveBeenCalled();
    expect(accessLookup).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("keeps duplicate unsend idempotent without requiring an active binding", async () => {
    const tombstoneSource = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const findActiveBinding = vi.fn();
    const app = createTestApp(config(), {
      mediaSyncStore: {
        tombstoneSource,
        findActiveBinding
      } as unknown as PostgresMediaSyncStore
    });
    const event = {
      type: "unsend",
      source: { type: "group", groupId: "G-unbound" },
      unsend: { messageId: "message-duplicate" }
    };

    const first = await inject(app, "/api/line/webhook/helper", "helper-secret", event);
    const duplicate = await inject(app, "/api/line/webhook/helper", "helper-secret", event);

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(tombstoneSource).toHaveBeenCalledTimes(2);
    expect(findActiveBinding).not.toHaveBeenCalled();
  });

  it("disables only the exact helper group binding on leave", async () => {
    const disableBinding = vi.fn().mockResolvedValue(true);
    const tombstoneSource = vi.fn();
    const app = createTestApp(config(), {
      mediaSyncStore: {
        disableBinding,
        tombstoneSource
      } as unknown as PostgresMediaSyncStore
    });

    const response = await inject(app, "/api/line/webhook/helper", "helper-secret", {
      type: "leave",
      source: { type: "group", groupId: "G-leaving" }
    });

    expect(response.statusCode).toBe(200);
    expect(disableBinding).toHaveBeenCalledWith({ profileName: "helper", groupId: "G-leaving" });
    expect(tombstoneSource).not.toHaveBeenCalled();
  });

  it.each([
    [
      "join",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "join", source: { type: "group", groupId: "G1" } }
    ],
    [
      "memberLeft",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "memberLeft", source: { type: "group", groupId: "G1" } }
    ],
    [
      "room",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "leave", source: { type: "room", roomId: "R1" } }
    ],
    [
      "direct",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "unsend", source: { type: "user", userId: "U1" }, unsend: { messageId: "M1" } }
    ],
    [
      "wrong profile",
      "/api/line/webhook/main",
      "main-secret",
      { type: "unsend", source: { type: "group", groupId: "G1" }, unsend: { messageId: "M1" } }
    ],
    [
      "oversized message ID",
      "/api/line/webhook/helper",
      "helper-secret",
      {
        type: "unsend",
        source: { type: "group", groupId: "G1" },
        unsend: { messageId: "界".repeat(86) }
      }
    ],
    [
      "control character group ID",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "leave", source: { type: "group", groupId: "G1\n" } }
    ]
  ])(
    "ignores %s lifecycle input without touching media state",
    async (_case, url, secret, event) => {
      const tombstoneSource = vi.fn();
      const disableBinding = vi.fn();
      const app = createTestApp(config(), {
        mediaSyncStore: {
          tombstoneSource,
          disableBinding
        } as unknown as PostgresMediaSyncStore
      });

      const response = await inject(app, url, secret, event);

      expect(response.statusCode).toBe(200);
      expect(tombstoneSource).not.toHaveBeenCalled();
      expect(disableBinding).not.toHaveBeenCalled();
    }
  );

  it.each(["missing", "failed"])(
    "returns 503 when eligible lifecycle storage is %s",
    async (mode) => {
      const app = createTestApp(config(), {
        ...(mode === "failed"
          ? {
              mediaSyncStore: {
                tombstoneSource: vi.fn().mockRejectedValue(new Error("postgres unavailable"))
              } as unknown as PostgresMediaSyncStore
            }
          : {})
      });

      const response = await inject(app, "/api/line/webhook/helper", "helper-secret", {
        type: "unsend",
        source: { type: "group", groupId: "G1" },
        unsend: { messageId: "M1" }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, error: "media_sync_lifecycle_unavailable" });
    }
  );
});

function config(): AppConfig {
  const profile = (name: "helper" | "main", secret: string) => ({
    name,
    webhookPath: `/api/line/webhook/${name}`,
    channelSecret: secret,
    channelAccessToken: `${name}-token`,
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text", "image", "file"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: [],
    permissionRequiredFunctions: [],
    adminDirectOnly: true,
    directAccessPolicy: "managed" as const,
    groupAccessPolicy: "managed" as const
  });
  return {
    serviceName: "hhc-line-function-bot",
    host: "127.0.0.1",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    maxBodyBytes: 32_768,
    profiles: [profile("helper", "helper-secret"), profile("main", "main-secret")],
    llm: {
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8_000
    }
  };
}

async function inject(
  app: ReturnType<typeof createTestApp>,
  url: string,
  secret: string,
  event: Record<string, unknown>
) {
  const body = JSON.stringify({ destination: "bot", events: [event] });
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      "x-line-signature": signLineBody(Buffer.from(body), secret)
    },
    payload: body
  });
}
