import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "redis";

import {
  createKernelRedisEnvironment,
  type KernelRedisEnvironment
} from "../evals/kernel/integration/environment.js";
import { runRedisIntegrationMatrix } from "../evals/kernel/integration/redis-matrix.js";
import { RedisSessionStore } from "../state/redis-session-store.js";

describe("kernel Redis integration environment", () => {
  let environment: KernelRedisEnvironment | undefined;

  afterAll(async () => {
    await environment?.cleanup();
  });

  it("requires an explicit real Redis URL", async () => {
    const original = process.env.KERNEL_REDIS_URL;
    delete process.env.KERNEL_REDIS_URL;
    try {
      await expect(createKernelRedisEnvironment()).rejects.toThrow(
        "kernel_integration_redis_url_required"
      );
    } finally {
      if (original === undefined) {
        delete process.env.KERNEL_REDIS_URL;
      } else {
        process.env.KERNEL_REDIS_URL = original;
      }
    }
  });

  it("owns two real clients under a random per-run namespace", async () => {
    environment = await createKernelRedisEnvironment();

    expect(environment.keyPrefix).toMatch(
      /^kernel-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    await expect(environment.clients[0].ping()).resolves.toBe("PONG");
    await expect(environment.clients[1].ping()).resolves.toBe("PONG");
  });

  it("passes the real Redis cross-replica and reconnect matrix", async () => {
    environment ??= await createKernelRedisEnvironment();

    const results = await runRedisIntegrationMatrix(environment);

    expect(results.map((result) => result.caseId)).toEqual([
      "redis/selection/atomic-consume",
      "redis/task-frame/requester-restart",
      "redis/job/scope-restart",
      "redis/webhook/cross-replica-deduplication",
      "redis/in-flight/cross-replica-lock",
      "redis/cache/cross-replica-invalidation",
      "redis/confirmation/actor-safe-consume",
      "redis/session/group-requester-isolation",
      "redis/session/atomic-interactive-replacement"
    ]);
    expect(results).toEqual(
      results.map((result) => ({
        caseId: result.caseId,
        boundary: result.boundary,
        passed: true
      }))
    );
  });

  it("clears the interactive index when handlers delete or take by id", async () => {
    environment ??= await createKernelRedisEnvironment();
    const store = new RedisSessionStore({
      client: environment.clients[0],
      keyPrefix: environment.keyPrefix
    });
    const source = { type: "group" as const, groupId: "G-handler", userId: "U-handler" };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await store.set({
      id: "handler-delete",
      type: "pending_attachment",
      action: "save_resource",
      profileName: "helper",
      requesterUserId: "U-handler",
      source,
      attachment: { messageId: "synthetic", messageType: "file" },
      expiresAt
    });
    await store.delete("handler-delete");
    expect(
      await environment.clients[0].keys(`${environment.keyPrefix}:interactive-session-v1:*`)
    ).toHaveLength(0);

    await store.set({
      id: "handler-take",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "U-handler",
      source,
      expiresAt
    });
    await expect(store.take("handler-take")).resolves.toMatchObject({ id: "handler-take" });
    expect(
      await environment.clients[0].keys(`${environment.keyPrefix}:interactive-session-v1:*`)
    ).toHaveLength(0);
  });

  it.each(["upload_intent", "pending_resolution"] as const)(
    "clears the interactive index after the %s side wins replacement",
    async (winner) => {
      environment ??= await createKernelRedisEnvironment();
      const stores = environment.clients.map(
        (client) => new RedisSessionStore({ client, keyPrefix: environment!.keyPrefix })
      );
      const suffix = `${winner}-${Date.now()}`;
      const source = { type: "group" as const, groupId: `G-${suffix}`, userId: "U-race" };
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const upload = {
        id: `upload-${suffix}`,
        type: "upload_intent" as const,
        profileName: "helper",
        requesterUserId: "U-race",
        source,
        expiresAt
      };
      const resolution = {
        id: `resolution-${suffix}`,
        type: "pending_resolution" as const,
        profileName: "helper",
        requesterUserId: "U-race",
        source,
        capability: "query_schedule" as const,
        groundedArguments: {},
        candidates: [{ id: "synthetic", domainKey: "synthetic", displayName: "synthetic" }],
        expiresAt
      };
      if (winner === "upload_intent") {
        await stores[1]!.set(resolution);
        await stores[0]!.set(upload);
      } else {
        await stores[0]!.set(upload);
        await stores[1]!.set(resolution);
      }

      const selectedUpload = await stores[0]!.takeUploadIntent({
        profileName: "helper",
        requesterUserId: "U-race",
        source
      });
      const selectedResolution = await stores[0]!.findPendingResolution({
        profileName: "helper",
        requesterUserId: "U-race",
        source
      });
      expect((selectedUpload ?? selectedResolution)?.type).toBe(winner);
      if (selectedResolution) await stores[0]!.delete(selectedResolution.id);
      expect(
        await environment.clients[0].keys(`${environment.keyPrefix}:interactive-session-v1:*`)
      ).toHaveLength(0);
    }
  );

  it("clear removes session records and interactive indexes", async () => {
    environment ??= await createKernelRedisEnvironment();
    const store = new RedisSessionStore({
      client: environment.clients[0],
      keyPrefix: environment.keyPrefix
    });
    await store.set({
      id: "clear-intent",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "U-clear",
      source: { type: "group", groupId: "G-clear", userId: "U-clear" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    await expect(store.clear()).resolves.toBe(2);
    expect(await environment.clients[0].keys(`${environment.keyPrefix}:session:*`)).toHaveLength(0);
    expect(
      await environment.clients[0].keys(`${environment.keyPrefix}:interactive-session-v1:*`)
    ).toHaveLength(0);
  });

  it("cleanup reconnects when replicas are closed and verifies its namespace is empty", async () => {
    const owned = await createKernelRedisEnvironment();
    const url = process.env.KERNEL_REDIS_URL!;
    await owned.clients[0].set(`${owned.keyPrefix}:synthetic`, "1");
    await Promise.all(owned.clients.map(async (client) => client.quit()));

    await owned.cleanup();

    const verifier = createClient({ url });
    verifier.on("error", () => undefined);
    await verifier.connect();
    try {
      await expect(verifier.keys(`${owned.keyPrefix}:*`)).resolves.toHaveLength(0);
    } finally {
      await verifier.quit();
    }
  });
});
