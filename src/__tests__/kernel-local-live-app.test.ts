import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createProviderBudget } from "../evals/kernel/local-live/budget.js";
import { kernelLocalLiveDirectUserId } from "../evals/kernel/local-live/contracts.js";
import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { createQueryScheduleHandler } from "../capabilities/query-schedule/handler.js";
import { createKernelLocalLiveApp } from "../testing/kernel-local-live/create-app.js";
import { kernelLocalLiveEventContextFromBody } from "../testing/kernel-local-live/create-app.js";
import {
  createKernelLocalLiveConfig,
  readKernelLocalLiveSecrets,
  type KernelLocalLiveSecretFileReader
} from "../testing/kernel-local-live/config.js";
import {
  createBudgetedProviderClients,
  createKernelLocalLiveCaseContext
} from "../testing/kernel-local-live/provider-clients.js";
import { seedKernelLocalLiveFixtures } from "../testing/kernel-local-live/fixtures.js";
import { createTestRuntime } from "../testing/create-test-runtime.js";

describe("Kernel local live secret files", () => {
  it("reads exactly two non-empty regular mode-0600 files without serializing values", async () => {
    const reader = secretReader({
      "deepseek-api-key": { mode: 0o100600, value: "deepseek-value\n" },
      "azure-openai-embedding-key": { mode: 0o100600, value: "embedding-value\n" }
    });

    const secrets = await readKernelLocalLiveSecrets("/run/secrets", reader);

    expect(secrets.deepSeekApiKey).toBe("deepseek-value");
    expect(secrets.azureEmbeddingApiKey).toBe("embedding-value");
    expect(() => JSON.stringify(secrets)).toThrow("kernel_local_live_secrets_not_serializable");
  });

  it.each([
    [{ mode: 0o120600, value: "value" }, "kernel_local_live_secret_not_regular"],
    [{ mode: 0o100640, value: "value" }, "kernel_local_live_secret_mode_invalid"],
    [{ mode: 0o100600, value: "\n" }, "kernel_local_live_secret_empty"]
  ])("rejects unsafe secret metadata %#", async (unsafe, expectedError) => {
    const reader = secretReader({
      "deepseek-api-key": unsafe,
      "azure-openai-embedding-key": { mode: 0o100600, value: "embedding-value" }
    });

    await expect(readKernelLocalLiveSecrets("/run/secrets", reader)).rejects.toThrow(expectedError);
  });
});

describe("Kernel local live config", () => {
  it("builds only the synthetic acceptance profile and local dependency URLs", () => {
    const config = createKernelLocalLiveConfig(
      {
        KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
        KERNEL_LOCAL_LIVE_POSTGRES_URL:
          "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
        KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379"
      },
      safeSecrets()
    );

    expect(config.profiles).toEqual([
      expect.objectContaining({
        name: "acceptance",
        webhookPath: "/api/line/webhook/acceptance",
        channelSecret: "kernel-local-live-channel-secret",
        channelAccessToken: "kernel-local-live-channel-token",
        enabledFunctions: ["query_schedule", "query_knowledge", "save_resource"],
        allowedProviders: ["deepseek"],
        schedulePolicy: {
          meetingWindows: [],
          domains: [
            expect.objectContaining({
              key: "synthetic_service",
              binding: {
                kind: "canonical",
                sourceKeys: ["synthetic-schedule"],
                allowLiveFallback: false
              }
            })
          ]
        }
      })
    ]);
    expect(config.database?.url).toContain("@postgres:5432/hhc_line_acceptance");
    expect(config.redis).toEqual({
      url: "redis://redis:6379",
      keyPrefix: "kernel-local-live:run-123"
    });
    expect(config.llm.deepseekApiKey).toBe("deepseek-value");
    expect(config.knowledge?.embedding.apiKey).toBe("embedding-value");
  });

  it.each([
    ["KERNEL_LOCAL_LIVE_POSTGRES_URL", "postgresql://kernel:kernel@production-db:5432/db"],
    ["KERNEL_LOCAL_LIVE_REDIS_URL", "redis://production-redis:6379"],
    ["LINE_HELPER_CHANNEL_SECRET", "production-line-secret"],
    ["GRAPH_CLIENT_SECRET", "production-graph-secret"],
    ["NOTION_TOKEN", "production-notion-token"],
    ["ATTACHMENT_SCAN_QUEUE_URL", "https://queue.example.invalid"],
    ["SEARXNG_BASE_URL", "https://search.example.invalid"]
  ])("rejects production connection setting %s", (name, value) => {
    const environment = {
      KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
      KERNEL_LOCAL_LIVE_POSTGRES_URL:
        "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
      KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379",
      [name]: value
    };

    expect(() => createKernelLocalLiveConfig(environment, safeSecrets())).toThrow(
      "kernel_local_live_production_setting_rejected"
    );
  });
});

describe("Kernel local live provider clients", () => {
  it("requires a declared case context and charges the real client before dispatch", async () => {
    let requests = 0;
    const budget = createProviderBudget({ deepSeekMax: 1, embeddingBatchMax: 0 });
    const caseContext = createKernelLocalLiveCaseContext();
    const observations: unknown[] = [];
    const config = createKernelLocalLiveConfig(
      {
        KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
        KERNEL_LOCAL_LIVE_POSTGRES_URL:
          "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
        KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379"
      },
      safeSecrets()
    );
    const clients = createBudgetedProviderClients({
      config,
      budget,
      caseContext,
      onProviderObservation: (observation) => observations.push(observation),
      fetchImpl: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"disposition":"deny"}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    await expect(
      clients.deepSeek.completeJson({
        profileName: "acceptance",
        prompt: "bounded prompt",
        text: "bounded input"
      })
    ).rejects.toThrow("kernel_local_live_case_context_missing");

    await caseContext.run("schedule-explicit", () =>
      clients.deepSeek.completeJson({
        profileName: "acceptance",
        prompt: "bounded prompt",
        text: "bounded input"
      })
    );
    expect(requests).toBe(1);
    expect(budget.snapshot().deepSeekRequests).toBe(1);
    expect(observations).toEqual([
      {
        provider: "deepseek",
        caseId: "schedule-explicit",
        ordinal: 1,
        outcome: "success"
      }
    ]);
  });

  it("forces the unavailable case locally without spending provider budget", async () => {
    let requests = 0;
    const budget = createProviderBudget({ deepSeekMax: 0, embeddingBatchMax: 0 });
    const caseContext = createKernelLocalLiveCaseContext();
    const config = createKernelLocalLiveConfig(
      {
        KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
        KERNEL_LOCAL_LIVE_POSTGRES_URL:
          "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
        KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379"
      },
      safeSecrets()
    );
    const clients = createBudgetedProviderClients({
      config,
      budget,
      caseContext,
      fetchImpl: async () => {
        requests += 1;
        return new Response();
      }
    });

    await expect(
      caseContext.run("provider-unavailable", () =>
        clients.deepSeek.completeJson({
          profileName: "acceptance",
          prompt: "bounded prompt",
          text: "bounded input"
        })
      )
    ).rejects.toThrow("kernel_local_live_forced_provider_unavailable");
    expect(requests).toBe(0);
    expect(budget.snapshot().deepSeekRequests).toBe(0);
  });

  it("reuses an exact seeded embedding without another provider request", async () => {
    let requests = 0;
    const budget = createProviderBudget({ deepSeekMax: 0, embeddingBatchMax: 1 });
    const caseContext = createKernelLocalLiveCaseContext();
    const config = createKernelLocalLiveConfig(
      {
        KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
        KERNEL_LOCAL_LIVE_POSTGRES_URL:
          "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
        KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379"
      },
      safeSecrets()
    );
    const clients = createBudgetedProviderClients({
      config,
      budget,
      caseContext,
      fetchImpl: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.25) }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    const first = await caseContext.run("capability-switch", () =>
      clients.embedding.embed(["synthetic alpha procedure"])
    );
    const second = await caseContext.run("capability-switch", () =>
      clients.embedding.embed(["synthetic alpha procedure"])
    );

    expect(second).toEqual(first);
    expect(requests).toBe(1);
    expect(budget.snapshot().embeddingBatches).toBe(1);
  });

  it("does not reuse an embedding across independently budgeted cases", async () => {
    let requests = 0;
    const budget = createProviderBudget({ deepSeekMax: 0, embeddingBatchMax: 3 });
    const caseContext = createKernelLocalLiveCaseContext();
    const config = createKernelLocalLiveConfig(
      {
        KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
        KERNEL_LOCAL_LIVE_POSTGRES_URL:
          "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
        KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379"
      },
      safeSecrets()
    );
    const clients = createBudgetedProviderClients({
      config,
      budget,
      caseContext,
      fetchImpl: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.25) }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    await caseContext.run("capability-switch", () =>
      clients.embedding.embed(["synthetic alpha procedure"])
    );
    await caseContext.run("knowledge-follow-up", () =>
      clients.embedding.embed(["synthetic alpha procedure"])
    );

    expect(requests).toBe(2);
    expect(budget.snapshot().embeddingBatches).toBe(2);
  });
});

describe("Kernel local live application composition", () => {
  it("derives the bounded case and zero-based turn from an exact event ID", () => {
    expect(
      kernelLocalLiveEventContextFromBody({
        events: [{ webhookEventId: "schedule-refinement:turn-2" }]
      })
    ).toEqual({ caseId: "schedule-refinement", turnIndex: 1 });
    expect(
      kernelLocalLiveEventContextFromBody({
        events: [{ webhookEventId: "schedule-refinement:unexpected" }]
      })
    ).toBeUndefined();
  });

  it("uses the real signed webhook transport and a local reply adapter", async () => {
    const config = createKernelLocalLiveConfig(
      {
        KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
        KERNEL_LOCAL_LIVE_POSTGRES_URL:
          "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
        KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379"
      },
      safeSecrets()
    );
    const runtime = createTestRuntime();
    const caseContext = createKernelLocalLiveCaseContext();
    const replies: Array<{ token: string; text: string }> = [];
    const app = createKernelLocalLiveApp({
      config,
      deepSeek: {
        providerName: "deepseek",
        async completeJson() {
          throw new Error("provider_must_not_run_for_help");
        },
        async completeText() {
          throw new Error("provider_must_not_run_for_help");
        }
      },
      caseContext,
      embedding: {
        provider: "azure_openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        async embed() {
          throw new Error("embedding_must_not_run_for_help");
        }
      },
      registryClients: {
        sessionStore: runtime.stores.session,
        cache: runtime.stores.cache,
        memoryStore: runtime.stores.memory,
        catalog: runtime.stores.catalog,
        knowledgeStore: runtime.stores.knowledge,
        scheduleStore: runtime.stores.schedule,
        lineContent: {
          async getMessageContent() {
            throw new Error("line_content_must_not_run");
          }
        }
      },
      appDependencies: {
        createLineReplyClient: () => ({
          async replyText(token, text) {
            replies.push({ token, text });
          }
        }),
        createLineIdentityClient: () => ({
          async getUserDisplayName() {
            return "Synthetic Admin";
          },
          async getGroupDisplayName() {
            return "Synthetic Group";
          }
        })
      }
    });
    const body = JSON.stringify({
      destination: "synthetic-destination",
      events: [
        {
          type: "message",
          webhookEventId: "schedule-explicit:turn-1",
          replyToken: "reply-token-1",
          source: { type: "user", userId: "U_KERNEL_ADMIN" },
          message: { type: "text", id: "message-1", text: "/help" }
        }
      ]
    });
    const signature = createHmac("sha256", "kernel-local-live-channel-secret")
      .update(body)
      .digest("base64");

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/acceptance",
      headers: { "content-type": "application/json", "x-line-signature": signature },
      payload: body
    });

    expect(health.statusCode).toBe(200);
    expect({ statusCode: response.statusCode, body: response.body }).toEqual({
      statusCode: 200,
      body: '{"ok":true,"allowedEvents":1}'
    });
    expect(replies).toEqual([
      expect.objectContaining({
        token: "reply-token-1",
        text: expect.stringContaining("我目前可以協助：")
      })
    ]);
    expect(replies[0]?.text).toContain("- 查服事表：");
    expect(replies[0]?.text).toContain("- 查已加入知識：");
    expect(replies[0]?.text).toContain("- 保存連結資源：");
    expect(replies[0]?.text).not.toContain("/help admin");
    await app.close();
  });
});

describe("Kernel local live fixtures", () => {
  it("seeds only synthetic access, schedule, and promoted knowledge data", async () => {
    const runtime = createTestRuntime();
    const accessStore = new InMemoryAccessStore();
    let embeddingCalls = 0;

    await seedKernelLocalLiveFixtures({
      accessStore,
      catalogStore: runtime.stores.catalog,
      scheduleStore: runtime.stores.schedule,
      knowledgeStore: runtime.stores.knowledge,
      embedding: {
        provider: "azure_openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        async embed(input) {
          embeddingCalls += 1;
          expect(input).toHaveLength(3);
          return input.map((_, index) =>
            Array.from({ length: 1536 }, (__, dimension) => (dimension === index ? 1 : 0))
          );
        }
      },
      now: () => new Date("2026-07-26T00:00:00.000Z")
    });
    expect(embeddingCalls).toBe(1);

    await expect(
      accessStore.hasActivePrincipal("acceptance", "user", "U_KERNEL_USER_A")
    ).resolves.toBe(true);
    await expect(
      accessStore.hasActivePrincipal("acceptance", "group", "G_KERNEL_GROUP")
    ).resolves.toBe(true);
    await expect(
      accessStore.listUserFunctionGrants(
        "acceptance",
        kernelLocalLiveDirectUserId("write-preview-confirm")
      )
    ).resolves.toContain("save_resource");
    await expect(
      runtime.stores.schedule.searchItems({ profileName: "acceptance", limit: 10 })
    ).resolves.toHaveLength(3);
    await expect(
      runtime.stores.schedule.searchItems({
        profileName: "acceptance",
        sourceKeys: ["synthetic-schedule"],
        serviceDate: "2026-07-27",
        role: "投影",
        limit: 10
      })
    ).resolves.toEqual([
      expect.objectContaining({
        serviceDate: "2026-07-27",
        role: "投影",
        assignee: "Synthetic A"
      })
    ]);
    const config = createKernelLocalLiveConfig(
      {
        KERNEL_LOCAL_LIVE_RUN_ID: "run-123",
        KERNEL_LOCAL_LIVE_POSTGRES_URL:
          "postgresql://kernel:kernel@postgres:5432/hhc_line_acceptance",
        KERNEL_LOCAL_LIVE_REDIS_URL: "redis://redis:6379"
      },
      safeSecrets()
    );
    const querySchedule = createQueryScheduleHandler({
      memoryStore: runtime.stores.memory,
      scheduleStore: runtime.stores.schedule,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });
    await expect(
      querySchedule(
        {
          query: "synthetic service",
          dateIntent: "specific_date",
          specificDate: "2026-07-27",
          meeting: "Synthetic Service",
          role: "投影",
          domainKey: "synthetic_service"
        },
        {
          profile: config.profiles[0],
          event: {
            type: "message",
            source: { type: "user", userId: "U_KERNEL_USER_A" },
            message: { type: "text", text: "查 synthetic service 2026-07-27 投影服事" }
          }
        }
      )
    ).resolves.toMatchObject({
      agentResult: { status: "success" }
    });
    await expect(
      querySchedule(
        {
          query: "synthetic service",
          dateIntent: "specific_date",
          specificDate: "2026-07-27",
          meeting: "Synthetic Service",
          domainKey: "synthetic_service"
        },
        {
          profile: config.profiles[0],
          event: {
            type: "message",
            source: { type: "user", userId: "U_KERNEL_USER_A" },
            message: { type: "text", text: "查 synthetic service 2026-07-27 服事" }
          }
        }
      )
    ).resolves.toMatchObject({
      agentResult: { status: "success" }
    });
    await expect(
      runtime.stores.catalog.listSources({
        profileName: "acceptance",
        sourceKeys: ["xiaoha_database"]
      })
    ).resolves.toEqual([
      expect.objectContaining({
        enabled: true,
        capabilities: { read: ["general_resource"], write: ["general_resource"] }
      })
    ]);
    const sources = await runtime.stores.knowledge.listSources({ profileName: "acceptance" });
    expect(sources).toEqual([
      expect.objectContaining({
        sourceKey: "synthetic-handbook",
        enabled: true,
        syncStatus: "ready"
      })
    ]);
    await expect(
      runtime.stores.knowledge.search({
        profileName: "acceptance",
        query: "synthetic alpha procedure",
        queryEmbedding: Array.from({ length: 1536 }, (_, dimension) => (dimension === 2 ? 1 : 0)),
        embeddingProvider: "azure_openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        limit: 1
      })
    ).resolves.toEqual([
      expect.objectContaining({
        ordinal: 0,
        score: expect.any(Number)
      })
    ]);
  });

  it("skips knowledge seeding for a single non-knowledge case without embedding calls", async () => {
    const runtime = createTestRuntime();
    const accessStore = new InMemoryAccessStore();
    let embeddingCalls = 0;

    await seedKernelLocalLiveFixtures({
      accessStore,
      catalogStore: runtime.stores.catalog,
      scheduleStore: runtime.stores.schedule,
      knowledgeStore: runtime.stores.knowledge,
      embedding: {
        provider: "azure_openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        async embed() {
          embeddingCalls += 1;
          return [];
        }
      },
      seedKnowledge: false
    });

    expect(embeddingCalls).toBe(0);
    await expect(
      runtime.stores.knowledge.listSources({ profileName: "acceptance" })
    ).resolves.toEqual([]);
  });
});

function safeSecrets() {
  return {
    deepSeekApiKey: "deepseek-value",
    azureEmbeddingApiKey: "embedding-value",
    toJSON(): never {
      throw new Error("kernel_local_live_secrets_not_serializable");
    }
  };
}

function secretReader(
  files: Record<string, { mode: number; value: string }>
): KernelLocalLiveSecretFileReader {
  return {
    async lstat(filePath) {
      const file = files[filePath.split(/[\\/]/u).at(-1) ?? ""];
      if (!file) throw new Error("ENOENT");
      return {
        mode: file.mode,
        isFile: () => (file.mode & 0o170000) === 0o100000,
        isSymbolicLink: () => (file.mode & 0o170000) === 0o120000
      };
    },
    async readFile(filePath) {
      const file = files[filePath.split(/[\\/]/u).at(-1) ?? ""];
      if (!file) throw new Error("ENOENT");
      return file.value;
    },
    async readdir() {
      return Object.keys(files);
    }
  };
}
