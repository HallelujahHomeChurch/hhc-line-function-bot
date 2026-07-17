import { describe, expect, it } from "vitest";

import { activeTaskFromResult, type ActiveTaskContext } from "../agent/active-task.js";
import {
  type ConversationWindowStore,
  InMemoryConversationWindowStore,
  RedisConversationWindowStore
} from "../agent/context-manager.js";

const scope = { profileName: "helper", sourceKey: "group:G1", requesterUserId: "U1" };

const previousTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_schedule",
  allowedCapabilities: ["query_schedule"],
  anchors: { date: "2026-07-14", meeting: "晨更" },
  entities: [
    {
      type: "role",
      key: "front-camera",
      label: "前攝影",
      aliases: ["攝影"]
    }
  ],
  supportedOperations: ["continue", "refine", "advance"],
  responseContext: {
    availableFields: ["date", "meeting", "scheduleType", "role"],
    defaultProjection: "focused"
  },
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

interface ActiveTaskBackend {
  name: string;
  store: ConversationWindowStore;
  setNow(value: string): void;
  records?: Map<string, string>;
  ttlByKey?: Map<string, number>;
}

function activeTaskBackends(): ActiveTaskBackend[] {
  let memoryNow = new Date("2026-07-13T00:00:00.000Z");
  let redisNow = new Date("2026-07-13T00:00:00.000Z");
  const records = new Map<string, string>();
  const ttlByKey = new Map<string, number>();
  return [
    {
      name: "memory",
      store: new InMemoryConversationWindowStore({ now: () => memoryNow }),
      setNow: (value) => {
        memoryNow = new Date(value);
      }
    },
    {
      name: "redis",
      store: new RedisConversationWindowStore({
        client: {
          get: async (key) => records.get(key) ?? null,
          setEx: async (key, seconds, value) => {
            records.set(key, value);
            ttlByKey.set(key, seconds);
          },
          del: async (key) => records.delete(key)
        },
        keyPrefix: "test",
        now: () => redisNow
      }),
      setNow: (value) => {
        redisNow = new Date(value);
      },
      records,
      ttlByKey
    }
  ];
}

describe("structured result active tasks", () => {
  it("derives a version-2 task frame with an independent ten-minute lifetime", () => {
    const task = activeTaskFromResult(
      "query_schedule",
      {
        ok: true,
        replyText: "音控：資恆",
        agentResult: {
          status: "success",
          replyText: "音控：資恆",
          anchors: { date: "2026-07-16" },
          entities: [{ type: "role", key: "audio", label: "音控" }],
          supportedOperations: ["continue", "refine"]
        }
      },
      new Date("2026-07-16T10:00:00.000Z"),
      600_000
    );

    expect(task).toMatchObject({
      version: 2,
      currentCapability: "query_schedule",
      allowedCapabilities: ["query_schedule"],
      createdAt: "2026-07-16T10:00:00.000Z",
      expiresAt: "2026-07-16T10:10:00.000Z"
    });
  });

  it("derives an active task only from a successful structured result", () => {
    const task = activeTaskFromResult(
      "query_schedule",
      {
        ok: true,
        replyText: "前攝影：姵穎、佳美",
        agentResult: {
          status: "success",
          replyText: "前攝影：姵穎、佳美",
          anchors: { date: "2026-07-14", meeting: "晨更" },
          entities: [
            {
              type: "role",
              key: "front-camera",
              label: "前攝影",
              aliases: ["攝影"]
            }
          ],
          supportedOperations: ["continue", "refine", "advance"]
        }
      },
      new Date("2026-07-13T00:00:00.000Z"),
      60_000
    );

    expect(task).toEqual(previousTask);
  });

  it("deeply copies every structured result field during derivation", () => {
    const anchors = { date: "2026-07-14" };
    const reference = { itemId: "item-1" };
    const aliases = ["攝影"];
    const entity = { type: "role", key: "front-camera", label: "前攝影", aliases };
    const supportedOperations = ["continue"];
    const result = {
      ok: true,
      replyText: "前攝影：姵穎、佳美",
      agentResult: {
        status: "success" as const,
        replyText: "前攝影：姵穎、佳美",
        anchors,
        entities: [entity],
        evidence: [{ kind: "catalog", reference }],
        supportedOperations
      }
    };

    const task = activeTaskFromResult(
      "query_schedule",
      result,
      new Date("2026-07-13T00:00:00.000Z"),
      60_000
    );
    anchors.date = "2099-01-01";
    reference.itemId = "mutated";
    entity.label = "mutated";
    aliases[0] = "mutated";
    supportedOperations[0] = "mutated";

    expect(task).toMatchObject({
      anchors: { date: "2026-07-14" },
      references: { itemId: "item-1" },
      entities: [{ type: "role", key: "front-camera", label: "前攝影", aliases: ["攝影"] }],
      supportedOperations: ["continue"]
    });
  });

  it.each(["not_found", "ambiguous", "unavailable"] as const)(
    "does not derive an active task for a %s structured result",
    (status) => {
      expect(
        activeTaskFromResult(
          "query_schedule",
          {
            ok: true,
            replyText: "沒有結果",
            agentResult: { status, replyText: "沒有結果" }
          },
          new Date("2026-07-13T00:00:00.000Z"),
          60_000
        )
      ).toBeUndefined();
    }
  );

  it("does not derive an active task from a failed execution", () => {
    expect(
      activeTaskFromResult(
        "query_schedule",
        {
          ok: false,
          replyText: "失敗",
          agentResult: { status: "success", replyText: "不應儲存" }
        },
        new Date("2026-07-13T00:00:00.000Z"),
        60_000
      )
    ).toBeUndefined();
  });

  it("preserves the previous active task after a not-found refinement", async () => {
    const store = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-13T00:00:00.000Z")
    });
    await store.recordActiveTask({ scope, task: previousTask, ttlMs: 60_000 });

    const replacement = activeTaskFromResult(
      "query_schedule",
      {
        ok: true,
        replyText: "找不到下一筆",
        agentResult: { status: "not_found", replyText: "找不到下一筆" }
      },
      new Date("2026-07-13T00:00:10.000Z"),
      60_000
    );
    if (replacement) {
      await store.recordActiveTask({ scope, task: replacement, ttlMs: 60_000 });
    }

    await expect(store.activeTask(scope)).resolves.toEqual(previousTask);
  });

  it("isolates active tasks by requester and expires them absolutely", async () => {
    let current = new Date("2026-07-13T00:00:00.000Z");
    const store = new InMemoryConversationWindowStore({ now: () => current });
    await store.recordActiveTask({ scope, task: previousTask, ttlMs: 60_000 });

    await expect(store.activeTask({ ...scope, requesterUserId: "U2" })).resolves.toBeUndefined();

    current = new Date("2026-07-13T00:00:50.000Z");
    await store.recordTurn({ scope, role: "user", text: "最近還好嗎", ttlMs: 60_000 });
    current = new Date("2026-07-13T00:01:01.000Z");

    await expect(store.activeTask(scope)).resolves.toBeUndefined();
    await expect(store.isActive(scope)).resolves.toBe(true);
  });

  it("does not create shared active state when the requester id is missing", async () => {
    const store = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-13T00:00:00.000Z")
    });
    const unknownRequesterScope = {
      profileName: "helper",
      sourceKey: "group:G1"
    };

    await store.recordActiveTask({
      scope: unknownRequesterScope,
      task: previousTask,
      ttlMs: 60_000
    });

    await expect(store.activeTask(unknownRequesterScope)).resolves.toBeUndefined();
  });

  it("defensively copies stored and returned state on both backends", async () => {
    for (const backend of activeTaskBackends()) {
      const input = structuredClone(previousTask);
      await backend.store.recordActiveTask({ scope, task: input, ttlMs: 60_000 });
      input.anchors.date = "2099-01-01";
      input.entities[0]!.label = "mutated input";
      input.expiresAt = "2099-01-01T00:00:00.000Z";

      const firstRead = await backend.store.activeTask(scope);
      expect(firstRead, backend.name).toEqual(previousTask);
      firstRead!.anchors.date = "2099-02-01";
      firstRead!.entities[0]!.aliases![0] = "mutated output";
      firstRead!.expiresAt = "2099-02-01T00:00:00.000Z";

      await expect(backend.store.activeTask(scope), backend.name).resolves.toEqual(previousTask);
    }
  });

  it("keeps requester isolation and absolute expiry identical on both backends", async () => {
    for (const backend of activeTaskBackends()) {
      await backend.store.recordActiveTask({ scope, task: previousTask, ttlMs: 60_000 });
      await expect(
        backend.store.activeTask({ ...scope, requesterUserId: "U2" }),
        backend.name
      ).resolves.toBeUndefined();

      backend.setNow("2026-07-13T00:00:50.000Z");
      await backend.store.recordTurn({
        scope,
        role: "user",
        text: "最近還好嗎",
        ttlMs: 60_000
      });
      backend.setNow("2026-07-13T00:01:01.000Z");
      await expect(backend.store.activeTask(scope), backend.name).resolves.toBeUndefined();
      await expect(backend.store.isActive(scope), backend.name).resolves.toBe(true);
    }
  });

  it("uses task expiry as the authoritative Redis TTL and never records expired tasks", async () => {
    for (const backend of activeTaskBackends()) {
      await backend.store.recordActiveTask({ scope, task: previousTask, ttlMs: 1 });
      backend.setNow("2026-07-13T00:00:30.000Z");
      await expect(backend.store.activeTask(scope), backend.name).resolves.toEqual(previousTask);
      if (backend.ttlByKey) {
        expect(Array.from(backend.ttlByKey.values()), backend.name).toEqual([60]);
      }

      await backend.store.clearActiveTask(scope);
      backend.setNow("2026-07-13T00:02:00.000Z");
      await backend.store.recordActiveTask({ scope, task: previousTask, ttlMs: 600_000 });
      await expect(backend.store.activeTask(scope), backend.name).resolves.toBeUndefined();
      if (backend.records) {
        expect(backend.records.size, backend.name).toBe(0);
      }
    }
  });

  it("bounds and sanitizes persisted task context", async () => {
    const store = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-13T00:00:00.000Z")
    });
    await store.recordActiveTask({
      scope,
      ttlMs: 60_000,
      task: {
        ...previousTask,
        anchors: {
          long: "a".repeat(600),
          nested: { secret: "drop" },
          choices: Array.from({ length: 12 }, (_, index) => `choice-${index}-${"b".repeat(210)}`)
        },
        entities: [
          {
            type: `type-${"t".repeat(210)}`,
            key: `key-${"k".repeat(210)}`,
            label: `label-${"l".repeat(510)}`,
            aliases: Array.from(
              { length: 12 },
              (_, aliasIndex) => `alias-${aliasIndex}-${"x".repeat(210)}`
            )
          },
          ...Array.from({ length: 21 }, (_, index) => ({
            type: "role",
            key: `role-${index}`,
            label: `角色 ${index}`
          }))
        ],
        references: { resourceId: "r".repeat(600) },
        supportedOperations: Array.from(
          { length: 10 },
          (_, index) => `operation-${index}-${"o".repeat(210)}`
        )
      }
    });

    const task = await store.activeTask(scope);
    expect(task?.anchors.long).toHaveLength(500);
    expect(task?.anchors.nested).toBeUndefined();
    expect(task?.anchors.choices).toHaveLength(10);
    expect((task?.anchors.choices as string[])[0]).toHaveLength(200);
    expect(task?.entities).toHaveLength(20);
    expect(task?.entities[0]?.type).toHaveLength(200);
    expect(task?.entities[0]?.key).toHaveLength(200);
    expect(task?.entities[0]?.label).toHaveLength(500);
    expect(task?.entities[0]?.aliases).toHaveLength(10);
    expect(task?.entities[0]?.aliases?.[0]).toHaveLength(200);
    expect(task?.references?.resourceId).toHaveLength(500);
    expect(task?.supportedOperations).toHaveLength(8);
    expect(task?.supportedOperations[0]).toHaveLength(200);
  });

  it("rejects sensitive, link-like, or over-budget state on both backends", async () => {
    const unsafeTasks: ActiveTaskContext[] = [
      { ...previousTask, anchors: { accessToken: "abc123" } },
      { ...previousTask, anchors: { note: "sk-proj-abcdefghijklmnop123456" } },
      { ...previousTask, references: { url: "https://temp.example/share/abc" } },
      {
        ...previousTask,
        anchors: {
          ...Object.fromEntries(
            Array.from({ length: 16 }, (_, index) => [`part${index}`, `value-${index}`])
          ),
          hidden: "https://temp.example/share/split"
        }
      },
      {
        ...previousTask,
        entities: Array.from({ length: 20 }, (_, index) => ({
          type: "role",
          key: `role-${index}-${"k".repeat(180)}`,
          label: `label-${index}-${"l".repeat(480)}`,
          aliases: Array.from({ length: 10 }, () => "a".repeat(190))
        }))
      }
    ];

    for (const backend of activeTaskBackends()) {
      for (const task of unsafeTasks) {
        await backend.store.recordActiveTask({ scope, task, ttlMs: 60_000 });
        await expect(backend.store.activeTask(scope), backend.name).resolves.toBeUndefined();
      }
    }
  });

  it.each([
    ["Chinese password key", { anchors: { 密碼: "ordinary-looking-value" } }],
    ["full-width API key", { anchors: { ＡＰＩ＿ＫＥＹ: "ordinary-looking-value" } }],
    ["GitHub token", { anchors: { note: `ghp_${"a".repeat(36)}` } }],
    ["fine-grained GitHub token", { anchors: { note: `github_pat_${"a".repeat(30)}` } }],
    ["Slack bot token", { anchors: { note: "xoxb-1234567890-abcdefghijklmnop" } }],
    ["Slack user token", { anchors: { note: "xoxp-1234567890-abcdefghijklmnop" } }],
    ["AWS access key", { anchors: { note: "AKIAIOSFODNN7EXAMPLE" } }],
    ["generic API key", { anchors: { note: "api_key_abcdefghijklmnop123456" } }]
  ])("rejects normalized sensitive metadata: %s", async (_name, override) => {
    for (const backend of activeTaskBackends()) {
      const task = { ...previousTask, ...override };
      await backend.store.recordActiveTask({ scope, task, ttlMs: 60_000 });
      await expect(backend.store.activeTask(scope), backend.name).resolves.toBeUndefined();
    }
  });

  it.each([
    "https://user:password@example.org/reference",
    "https://example.org/reference?sig=secret-signature",
    "https://blob.core.windows.net/file.pdf?sv=2024-01-01&sp=r&sig=secret",
    "https://example.org/reference#access_token=secret",
    "https://example.org/share/temporary-result",
    "https://example.org/reference?redirect=https%3A%2F%2F1drv.ms%2Fabc"
  ])("rejects secret-bearing or generated evidence URL: %s", async (url) => {
    for (const backend of activeTaskBackends()) {
      await backend.store.recordActiveTask({
        scope,
        task: { ...previousTask, references: { url } },
        ttlMs: 60_000
      });
      await expect(backend.store.activeTask(scope), backend.name).resolves.toBeUndefined();
    }
  });

  it.each([
    ["temporary authorization query", "https://example.org/reference?tempauth=ordinary-value"],
    [
      "double-encoded nested share URL",
      "https://example.org/reference/https%253A%252F%252F1drv.ms%252Fabc"
    ],
    ["benign query string", "https://en.wikipedia.org/wiki/Fastify?uselang=zh"],
    ["empty query marker", "https://example.org/reference?"],
    ["empty fragment marker", "https://example.org/reference#"]
  ])("rejects non-stable evidence locator: %s", async (_name, url) => {
    for (const backend of activeTaskBackends()) {
      await backend.store.recordActiveTask({
        scope,
        task: { ...previousTask, references: { url } },
        ttlMs: 60_000
      });
      await expect(backend.store.activeTask(scope), backend.name).resolves.toBeUndefined();
    }
  });

  it("accepts benign Chinese anchors and a stable public evidence URL", async () => {
    const task: ActiveTaskContext = {
      ...previousTask,
      anchors: { 日期: "2026-07-14", 聚會: "晨更", 角色: ["前攝影", "音控"] },
      references: {
        pageId: "fastify",
        url: "https://en.wikipedia.org/wiki/Fastify"
      }
    };
    for (const backend of activeTaskBackends()) {
      await backend.store.recordActiveTask({ scope, task, ttlMs: 60_000 });
      await expect(backend.store.activeTask(scope), backend.name).resolves.toEqual(task);
    }
  });

  it("fails closed for unknown evidence reference keys", async () => {
    for (const backend of activeTaskBackends()) {
      await backend.store.recordActiveTask({
        scope,
        task: { ...previousTask, references: { unexpectedId: "value" } },
        ttlMs: 60_000
      });
      await expect(backend.store.activeTask(scope), backend.name).resolves.toBeUndefined();
    }
  });

  it("caps arbitrary anchor-key splitting identically on both backends", async () => {
    const task = {
      ...previousTask,
      anchors: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`part${index}`, `value-${index}`])
      )
    };
    for (const backend of activeTaskBackends()) {
      await backend.store.recordActiveTask({ scope, task, ttlMs: 60_000 });
      const stored = await backend.store.activeTask(scope);
      expect(Object.keys(stored!.anchors), backend.name).toHaveLength(16);
    }
  });

  it.each([
    ["invalid JSON", "{"],
    ["null", "null"],
    ["wrong version", JSON.stringify({ ...previousTask, version: 1 })],
    ["unknown capability", JSON.stringify({ ...previousTask, capability: "unknown" })],
    ["invalid timestamp", JSON.stringify({ ...previousTask, createdAt: "not-a-date" })],
    [
      "invalid expiry ordering",
      JSON.stringify({ ...previousTask, expiresAt: previousTask.createdAt })
    ],
    ["malformed anchors", JSON.stringify({ ...previousTask, anchors: { nested: {} } })],
    [
      "excessive anchor keys",
      JSON.stringify({
        ...previousTask,
        anchors: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`part${index}`, `value-${index}`])
        )
      })
    ],
    [
      "prototype-polluting anchor key",
      JSON.stringify({
        ...previousTask,
        anchors: JSON.parse('{"__proto__":"polluted"}') as Record<string, unknown>
      })
    ],
    ["malformed entities", JSON.stringify({ ...previousTask, entities: [{ label: "missing" }] })],
    [
      "malformed references",
      JSON.stringify({ ...previousTask, references: { values: [1, 2, 3] } })
    ],
    [
      "excessive operations",
      JSON.stringify({
        ...previousTask,
        supportedOperations: Array.from({ length: 9 }, (_, index) => `op-${index}`)
      })
    ],
    ["sensitive value", JSON.stringify({ ...previousTask, anchors: { note: "Bearer abc123" } })]
  ])("rejects malformed Redis payload: %s", async (_name, raw) => {
    const backend = activeTaskBackends().find((entry) => entry.name === "redis")!;
    await backend.store.recordActiveTask({ scope, task: previousTask, ttlMs: 60_000 });
    const key = Array.from(backend.records!.keys())[0]!;
    backend.records!.set(key, raw);

    await expect(backend.store.activeTask(scope)).resolves.toBeUndefined();
  });

  it("stores Redis active tasks under an independent versioned key and clears them", async () => {
    const records = new Map<string, string>();
    const store = new RedisConversationWindowStore({
      client: {
        get: async (key) => records.get(key) ?? null,
        setEx: async (key, _seconds, value) => records.set(key, value),
        del: async (key) => records.delete(key)
      },
      keyPrefix: "test",
      now: () => new Date("2026-07-13T00:00:00.000Z")
    });

    await store.recordActiveTask({ scope, task: previousTask, ttlMs: 60_000 });
    expect(Array.from(records.keys())).toEqual([expect.stringContaining(":task-frame-v2:")]);
    await expect(store.activeTask(scope)).resolves.toEqual(previousTask);

    await store.clearActiveTask(scope);
    await expect(store.activeTask(scope)).resolves.toBeUndefined();
  });
});
