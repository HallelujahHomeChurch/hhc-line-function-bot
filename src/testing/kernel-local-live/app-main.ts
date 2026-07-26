import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createAccessStore } from "../../access/create-access-store.js";
import { RedisRegistrationInviteCodeStore } from "../../access/registration-invite-code-store.js";
import { RedisConfirmationStore } from "../../actions/confirmation-store.js";
import { createAgentMemoryStore } from "../../agent/create-agent-memory-store.js";
import { createAgentRuntime } from "../../agent/agent-runtime.js";
import { RedisConversationWindowStore } from "../../agent/context-manager.js";
import { RedisAgentJobStore } from "../../agent/jobs.js";
import { RedisAgentTraceStore } from "../../agent/trace-store.js";
import type { AttachmentScanQueue } from "../../attachments/scan-queue.js";
import {
  RedisAttachmentScanWorkStore,
  type AttachmentScanWorkStore
} from "../../attachments/scan-work-store.js";
import { createCacheStore } from "../../cache/create-cache-store.js";
import { createCatalogStore } from "../../catalog/create-catalog-store.js";
import { createPostgresRuntime } from "../../db/postgres.js";
import { createDependencyDiagnostics } from "../../diagnostics/dependencies.js";
import {
  selectKernelLocalLiveCases,
  validateKernelLocalLiveCost
} from "../../evals/kernel/local-live/cases.js";
import { createProviderBudget } from "../../evals/kernel/local-live/budget.js";
import { createInFlightStore } from "../../in-flight/create-in-flight-store.js";
import { createWebhookEventStore } from "../../idempotency/create-webhook-event-store.js";
import { createKnowledgeStore } from "../../knowledge/create-store.js";
import { createLastErrorStore } from "../../observability/create-last-error-store.js";
import { createLastRouteStore } from "../../observability/create-last-route-store.js";
import { createRateLimiter } from "../../rate-limit.js";
import { createRedisRuntime } from "../../redis.js";
import { createScheduleStore } from "../../schedules/create-schedule-store.js";
import { createSessionStore } from "../../state/create-session-store.js";
import type { LineContentClient } from "../../types.js";
import { createCaptureLineReplyClient } from "./capture-line-client.js";
import { createKernelLocalLiveConfig, readKernelLocalLiveSecrets } from "./config.js";
import { createKernelLocalLiveApp } from "./create-app.js";
import { seedKernelLocalLiveFixtures } from "./fixtures.js";
import {
  createBudgetedProviderClients,
  createKernelLocalLiveCaseContext
} from "./provider-clients.js";
import { RedisKernelLocalLiveChannel, type KernelLocalLiveRedisClient } from "./redis-channel.js";

const SECRET_DIRECTORY = "/run/secrets";

export async function runKernelLocalLiveApp(
  environment: Record<string, string | undefined> = process.env
): Promise<void> {
  const secrets = await readKernelLocalLiveSecrets(SECRET_DIRECTORY);
  const config = createKernelLocalLiveConfig(environment, secrets);
  const selectedCases = selectKernelLocalLiveCases(
    environment.KERNEL_LOCAL_LIVE_CASE_ID?.trim() || undefined
  );
  const budget = createProviderBudget(validateKernelLocalLiveCost(selectedCases));
  const caseContext = createKernelLocalLiveCaseContext();
  const redis = await createRedisRuntime(config.redis, {
    onError: () => undefined
  });
  const postgres = await createPostgresRuntime(config.database);
  if (!redis || !postgres) throw new Error("kernel_local_live_dependencies_missing");
  const runId = environment.KERNEL_LOCAL_LIVE_RUN_ID!;
  const channel = new RedisKernelLocalLiveChannel(
    redis.client as unknown as KernelLocalLiveRedisClient,
    runId
  );
  const providers = createBudgetedProviderClients({
    config,
    budget,
    caseContext,
    onProviderObservation: (observation) =>
      channel.appendObservation({ ...observation, kind: "provider" })
  });
  const accessStore = await createAccessStore({ db: postgres.pool });
  const memoryStore = await createAgentMemoryStore({ db: postgres.pool });
  const catalog = await createCatalogStore({ db: postgres.pool });
  const scheduleStore = await createScheduleStore({ db: postgres.pool });
  const knowledgeStore = await createKnowledgeStore({ db: postgres.pool });
  const sessionStore = createSessionStore({ redis });
  const cache = createCacheStore({ redis });
  const agentJobStore = new RedisAgentJobStore({
    client: redis.client,
    keyPrefix: redis.keyPrefix
  });
  const baseScanWorkStore = new RedisAttachmentScanWorkStore({
    client: redis.client,
    keyPrefix: redis.keyPrefix,
    jobStore: agentJobStore
  });
  const scanWorkStore: AttachmentScanWorkStore = new Proxy(baseScanWorkStore, {
    get(target, property) {
      if (property === "markEnqueued") {
        return async (workId: string) => {
          const marked = await target.markEnqueued(workId);
          if (marked) {
            await channel.appendObservation({
              caseId: "write-preview-confirm",
              kind: "scan_work",
              ordinal: 1,
              outcome: "queued"
            });
          }
          return marked;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const scanQueue: AttachmentScanQueue = {
    async enqueue() {
      const existing = (await channel.readObservations()).filter(
        ({ caseId, kind }) => caseId === "write-preview-confirm" && kind === "queue"
      ).length;
      await channel.appendObservation({
        caseId: "write-preview-confirm",
        kind: "queue",
        ordinal: existing + 1,
        outcome: "queued"
      });
    }
  };
  const knowledgeFixtureCase = selectedCases.some(({ id }) => id === "capability-switch")
    ? "capability-switch"
    : "knowledge-follow-up";
  await caseContext.run(knowledgeFixtureCase, () =>
    seedKernelLocalLiveFixtures({
      accessStore,
      catalogStore: catalog,
      scheduleStore,
      knowledgeStore,
      embedding: providers.embedding,
      seedKnowledge: selectedCases.some(
        ({ id }) => id === "capability-switch" || id === "knowledge-follow-up"
      )
    })
  );

  const conversationWindowStore = new RedisConversationWindowStore({
    client: redis.client,
    keyPrefix: redis.keyPrefix
  });
  const agentTraceStore = new RedisAgentTraceStore({
    client: redis.client,
    keyPrefix: redis.keyPrefix,
    maxEntries: 100
  });
  const registrationInviteCodeStore = new RedisRegistrationInviteCodeStore({
    client: redis.client,
    keyPrefix: redis.keyPrefix
  });
  const confirmationStore = new RedisConfirmationStore({
    client: redis.client,
    keyPrefix: redis.keyPrefix
  });
  const lastErrorStore = createLastErrorStore({ redis, maxEntries: 20 });
  const lastRouteStore = createLastRouteStore({ redis, maxEntries: 20 });
  const inFlightStore = createInFlightStore({ redis });
  const webhookEventStore = createWebhookEventStore(redis);
  const rateLimiter = createRateLimiter({
    redis,
    config: config.rateLimit!
  });
  const applicationAgentRuntime = createAgentRuntime({
    memoryStore,
    accessStore
  });
  const lineContent: LineContentClient = {
    async getMessageContent() {
      throw new Error("kernel_local_live_line_content_forbidden");
    }
  };
  const captureReply = createCaptureLineReplyClient(channel);
  const app = createKernelLocalLiveApp({
    config,
    deepSeek: providers.deepSeek,
    embedding: providers.embedding,
    caseContext,
    registryClients: {
      sessionStore,
      cache,
      memoryStore,
      catalog,
      knowledgeStore,
      scheduleStore,
      lineContent,
      accessStore,
      agentJobStore,
      attachmentScanQueue: scanQueue,
      attachmentScanWorkStore: scanWorkStore,
      requestIdFactory: randomUUID
    },
    appDependencies: {
      createLineReplyClient: () => captureReply,
      createLineIdentityClient: () => ({
        async getUserDisplayName(userId) {
          return userId.startsWith("U_KERNEL_") ? "Synthetic User" : undefined;
        },
        async getGroupDisplayName(groupId) {
          return groupId === "G_KERNEL_GROUP" ? "Synthetic Group" : undefined;
        }
      }),
      accessStore,
      registrationInviteCodeStore,
      confirmationStore,
      lastErrorStore,
      lastRouteStore,
      inFlightStore,
      webhookEventStore,
      rateLimiter,
      agentTraceStore,
      sessionStore,
      agentJobStore,
      conversationWindowStore,
      agentRuntime: applicationAgentRuntime,
      diagnostics: createDependencyDiagnostics({
        config,
        postgres: postgres.pool,
        redis: redis.client
      }),
      requestIdFactory: randomUUID
    }
  });

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= Promise.allSettled([app.close(), redis.close(), postgres.pool.end()]).then(
      (results) => {
        if (results.some(({ status }) => status === "rejected")) {
          throw new Error("kernel_local_live_app_cleanup_failed");
        }
      }
    );
    return closing;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().catch(() => {
        process.exitCode = 2;
      });
    });
  }
  try {
    await app.listen({ host: config.host, port: config.port });
    console.log("kernel_local_live_app_ready");
  } catch (error) {
    await close();
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    await runKernelLocalLiveApp();
  } catch {
    console.error("kernel_local_live_app_failed");
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
