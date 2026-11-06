import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerSearchSettingsRoutes } from "../search-settings/http-routes.js";
import { createPublicSearchQuota } from "../state/public-search-quota.js";
const actor = "018f0c1f-18d0-7e81-9f6f-69c456db7003";
const settings = {
  enabled: true,
  directDailyLimit: 60,
  groupDailyLimit: 300,
  revision: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: null
};
const headers = {
  "dapr-caller-app-id": "api-gateway",
  "dapr-api-token": "synthetic",
  "x-hhc-user-id": actor
};

describe("search settings management", () => {
  it("requires the trusted gateway and fresh administrator authority on reads and writes", async () => {
    const app = Fastify();
    const authorize = vi.fn(async () => true);
    const store = {
      get: vi.fn(async () => settings),
      history: vi.fn(async () => []),
      update: vi.fn(async () => ({ ...settings, revision: 2, updatedBy: actor }))
    };
    registerSearchSettingsRoutes(app, {
      store,
      authorize,
      gatewayCallerAppId: "api-gateway",
      appApiToken: "synthetic",
      gatewayPrivateToken: "a".repeat(64)
    });
    try {
      expect((await app.inject({ url: "/api/line/search-settings" })).statusCode).toBe(403);
      expect(authorize).not.toHaveBeenCalled();
      expect(
        (await app.inject({ url: "/api/line/search-settings", headers })).json().settings
      ).toEqual(settings);
      const privateHeaders = {
        "x-hhc-line-gateway-token": "a".repeat(64),
        "x-hhc-user-id": actor
      };
      expect(
        (await app.inject({ url: "/api/line/search-settings", headers: privateHeaders })).json()
          .settings
      ).toEqual(settings);
      expect(
        (
          await app.inject({
            url: "/api/line/search-settings",
            headers: { ...headers, ...privateHeaders }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: "/api/line/search-settings",
            headers: { ...headers, "x-hhc-line-gateway-token": "b".repeat(64) }
          })
        ).statusCode
      ).toBe(403);
      authorize.mockResolvedValue(false);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/line/search-settings",
            headers,
            payload: { enabled: true, directDailyLimit: 600, groupDailyLimit: 300, revision: 1 }
          })
        ).statusCode
      ).toBe(403);
      expect(store.update).not.toHaveBeenCalled();
      authorize.mockRejectedValue(new Error("secret"));
      const unavailable = await app.inject({ url: "/api/line/search-settings", headers });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.body).not.toContain("secret");
    } finally {
      await app.close();
    }
  });
  it("validates strict ranges and returns conflicts without replaying writes", async () => {
    const app = Fastify();
    app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_r, body, done) =>
      done(null, body)
    );
    const update = vi.fn(async () => undefined);
    registerSearchSettingsRoutes(app, {
      store: { get: async () => settings, history: async () => [], update },
      authorize: async () => true,
      gatewayCallerAppId: "api-gateway",
      appApiToken: "synthetic"
    });
    const valid = { enabled: true, directDailyLimit: 60, groupDailyLimit: 300, revision: 1 };
    try {
      for (const payload of [
        { ...valid, directDailyLimit: -1 },
        { ...valid, groupDailyLimit: 10001 },
        { ...valid, directDailyLimit: 1.5 },
        { ...valid, actor: "forged" },
        { ...valid, revision: 0 }
      ]) {
        expect(
          (
            await app.inject({
              method: "PATCH",
              url: "/api/line/search-settings",
              headers,
              payload
            })
          ).statusCode
        ).toBe(400);
      }
      expect(update).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/line/search-settings",
            headers,
            payload: valid
          })
        ).statusCode
      ).toBe(409);
      expect(update).toHaveBeenCalledExactlyOnceWith(valid, actor);
    } finally {
      await app.close();
    }
  });
  it("uses one group bucket across members, separate direct buckets, and Taipei midnight", async () => {
    const evalMock = vi.fn(async () => 1);
    let clock = new Date("2026-11-03T15:59:59Z");
    const getSettings = vi.fn(async () => settings);
    const reserve = createPublicSearchQuota({
      client: { eval: evalMock },
      settings: getSettings,
      keyPrefix: "synthetic",
      hmacKey: "synthetic",
      now: () => clock
    });
    await reserve("helper", { type: "group", groupId: "private-group", userId: "one" }, "one");
    await reserve("helper", { type: "group", groupId: "private-group", userId: "two" }, "two");
    expect(evalMock.mock.calls[0]![1].keys[0]).toBe(evalMock.mock.calls[1]![1].keys[0]);
    await reserve("helper", { type: "user", userId: "one" }, "three");
    expect(evalMock.mock.calls[2]![1].keys[0]).not.toBe(evalMock.mock.calls[0]![1].keys[0]);
    clock = new Date("2026-11-03T16:00:00Z");
    await reserve("helper", { type: "user", userId: "one" }, "four");
    expect(evalMock.mock.calls[2]![1].keys[0]).toContain("2026-11-03");
    expect(evalMock.mock.calls[3]![1].keys[0]).toContain("2026-11-04");
    expect(JSON.stringify(evalMock.mock.calls)).not.toContain("private-group");
    expect(await reserve("helper", { type: "group", groupId: "g" }, "missing-user")).toBe(false);
    expect(await reserve("main", { type: "user", userId: "one" }, "main")).toBe(false);
    getSettings.mockRejectedValue(new Error("unavailable"));
    expect(await reserve("helper", { type: "user", userId: "one" }, "db-down")).toBe(false);
    expect(evalMock).toHaveBeenCalledTimes(4);
  });
});
