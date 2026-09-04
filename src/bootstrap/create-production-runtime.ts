import { ChatDeepSeek } from "@langchain/deepseek";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { createAzureOpenAiEmbeddingClient } from "../clients/azure-openai-embedding.js";
import { createDeepSeekProvider } from "../clients/deepseek.js";
import { createAccountAdminClient } from "../account/account-admin-client.js";
import { createAdminActionRouter } from "../admin-action-router.js";
import { RedisConfirmationStore } from "../actions/confirmation-store.js";
import { createAdminActionRegistry } from "../actions/admin-registry.js";
import { createAccessStore } from "../access/create-access-store.js";
import {
  InMemoryRegistrationInviteCodeStore,
  RedisRegistrationInviteCodeStore
} from "../access/registration-invite-code-store.js";
import { createAgentMemoryStore } from "../agent/create-agent-memory-store.js";
import { backfillAgentTextMemoryEmbeddings } from "../agent/text-memory-embedding-backfill.js";
import { createAgentRuntime } from "../agent/agent-runtime.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import { createSdkAgentTurnRuntime } from "../agent/sdk-turn-runtime.js";
import { createPostgresSdkAgentState, createSdkAgentState } from "../agent/sdk-state.js";
import { createWikipediaSummarizer } from "../wikipedia/summarizer.js";
import { InMemoryAgentJobStore, RedisAgentJobStore } from "../agent/jobs.js";
import { createAzureAttachmentScanQueue } from "../attachments/scan-queue.js";
import {
  InMemoryAttachmentScanWorkStore,
  RedisAttachmentScanWorkStore
} from "../attachments/scan-work-store.js";
import {
  startAttachmentScanOutboxDispatcher,
  startMediaSyncOutboxDispatcher
} from "../attachments/scan-outbox.js";
import {
  InMemoryConversationWindowStore,
  RedisConversationWindowStore
} from "../agent/context-manager.js";
import { InMemoryAgentTraceStore, RedisAgentTraceStore } from "../agent/trace-store.js";
import { createCacheStore } from "../cache/create-cache-store.js";
import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "../catalog/source-seeds.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createAssetApiClient } from "../clients/asset-api.js";
import {
  createLineSdkContentClient,
  createLineSdkIdentityClient,
  createLineSdkReplyClient
} from "../clients/line.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { createNotionKnowledgeClient } from "../clients/notion-knowledge.js";
import { createSearxngClient } from "../clients/searxng.js";
import { createPublicPageReader } from "../clients/public-page.js";
import { createWikipediaClient } from "../wikipedia/client.js";
import { createDependencyDiagnostics } from "../diagnostics/dependencies.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { MediaSyncManagementService } from "../media-sync/service.js";
import { createFunctionRegistries } from "../functions/registry.js";
import { FUNCTION_MODULES } from "../functions/modules.js";
import { createQueryScheduleModule } from "../capabilities/query-schedule/module.js";
import { createWebhookEventStore } from "../idempotency/create-webhook-event-store.js";
import { createKnowledgeStore } from "../knowledge/create-store.js";
import { createProfileAwareProvider } from "../llm/provider-runtime.js";
import { createLastErrorStore } from "../observability/create-last-error-store.js";
import { createLastRouteStore } from "../observability/create-last-route-store.js";
import { createFirstSuccessStore } from "../observability/first-success-store.js";
import { createConsoleRouteObserver } from "../observability/route-observer.js";
import { createFunctionCompletionObserver } from "../application/turn/completion-observer.js";
import { createRateLimiter } from "../rate-limit.js";
import { createRedisRuntime } from "../redis.js";
import { createScheduleStore } from "../schedules/create-schedule-store.js";
import { createSheetMusicExternalSearchSummarizer } from "../search/sheet-music-external-summarizer.js";
import { createApp } from "../server.js";
import { createSessionStore } from "../state/create-session-store.js";
import type { AppConfig } from "../types.js";
import {
  assertProductionPersistence,
  type ApplicationRuntime,
  type ProductionRuntime
} from "./runtime-contracts.js";

export async function createProductionRuntime(config: AppConfig): Promise<ProductionRuntime> {
  assertProductionPersistence(config);
  return createRuntime(config);
}

export async function createLocalRuntime(config: AppConfig): Promise<ApplicationRuntime> {
  return createRuntime(config);
}

async function createRuntime(config: AppConfig): Promise<ApplicationRuntime> {
  const redis = await createRedisRuntime(config.redis);
  const postgres = await createPostgresRuntime(config.database);
  const accountAdminClient = createAccountAdminClient({
    baseUrl: config.account?.baseUrl ?? "http://127.0.0.1:3500/v1.0/invoke/account-api/method",
    timeoutMs: config.account?.timeoutMs ?? 3000
  });
  const mediaSyncManagementService = postgres?.mediaSyncStore
    ? new MediaSyncManagementService(
        createAssetApiClient({
          baseUrl: config.asset?.baseUrl ?? "http://127.0.0.1:3500/v1.0/invoke/asset-api/method",
          timeoutMs: config.asset?.timeoutMs ?? 3000
        }),
        postgres.mediaSyncStore
      )
    : undefined;

  const providers = {
    deepseek: createDeepSeekProvider({
      apiKey: config.llm.deepseekApiKey,
      baseUrl: config.llm.deepseekBaseUrl,
      model: config.llm.deepseekModel,
      timeoutMs: config.llm.deepseekTimeoutMs,
      routeMaxOutputTokens: config.llm.routeMaxOutputTokens ?? 256,
      generalMaxOutputTokens: config.llm.generalMaxOutputTokens ?? 512
    })
  };
  const adminRoutingPrimary = createProfileAwareProvider({
    config,
    providers,
    role: "primary",
    lane: "admin_routing"
  });
  const smartTalkPrimary = createProfileAwareProvider({
    config,
    providers,
    role: "primary",
    lane: "smart_talk"
  });
  const wikipediaSummaryPrimary = createProfileAwareProvider({
    config,
    providers,
    role: "primary",
    lane: "web_summarization"
  });
  const adminActionRouter = createAdminActionRouter({
    primary: adminRoutingPrimary,
    lane: "admin_routing"
  });
  const accessStore = await createAccessStore({ db: postgres?.pool });
  const memoryStore = await createAgentMemoryStore({ db: postgres?.pool });
  await memoryStore.purgeExpired();
  const memoryPurgeTimer = setInterval(
    () => {
      void memoryStore.purgeExpired().catch(() => undefined);
    },
    6 * 60 * 60 * 1000
  );
  memoryPurgeTimer.unref();
  const graph = config.graph ? createGraphDriveClient(config.graph) : undefined;
  const notion = config.notion ? createNotionDatabaseClient(config.notion) : undefined;
  const wikipedia = config.wikipedia ? createWikipediaClient(config.wikipedia) : undefined;
  const lineContent = createLineSdkContentClient();
  const webSearch = config.webSearch?.searxngBaseUrl
    ? createSearxngClient({
        baseUrl: config.webSearch.searxngBaseUrl,
        timeoutMs: config.webSearch.timeoutMs
      })
    : undefined;
  const publicPageReader = webSearch
    ? createPublicPageReader({
        maxBytes: 512 * 1024,
        maxRedirects: config.externalResources.maxRedirects,
        timeoutMs: config.externalResources.downloadTimeoutMs
      })
    : undefined;
  const registrationInviteCodeStore = redis
    ? new RedisRegistrationInviteCodeStore({ client: redis.client, keyPrefix: redis.keyPrefix })
    : new InMemoryRegistrationInviteCodeStore();
  const confirmationStore = redis
    ? new RedisConfirmationStore({ client: redis.client, keyPrefix: redis.keyPrefix })
    : undefined;
  const sessionStore = createSessionStore({ redis });
  const agentTraceStore = redis
    ? new RedisAgentTraceStore({
        client: redis.client,
        keyPrefix: redis.keyPrefix,
        maxEntries: config.lastErrors?.maxEntries ?? 20
      })
    : new InMemoryAgentTraceStore(config.lastErrors?.maxEntries ?? 20);
  const cache = createCacheStore({ redis });
  const catalog = await createCatalogStore({ db: postgres?.pool });
  await seedCatalogSources({
    catalog,
    sources: buildCatalogSourceSeedsForProfiles(process.env, config.profiles)
  });
  const scheduleStore = await createScheduleStore({ db: postgres?.pool });
  const knowledgeStore = await createKnowledgeStore({ db: postgres?.pool });
  await knowledgeStore.purgeExpired(new Date());
  const knowledgePurgeTimer = setInterval(
    () => {
      void knowledgeStore.purgeExpired(new Date()).catch(() => undefined);
    },
    6 * 60 * 60 * 1000
  );
  knowledgePurgeTimer.unref();
  const knowledgeEmbedding = config.knowledge
    ? createAzureOpenAiEmbeddingClient({
        apiKey: config.knowledge.embedding.apiKey,
        endpoint: config.knowledge.embedding.endpoint,
        deployment: config.knowledge.embedding.deployment,
        apiVersion: config.knowledge.embedding.apiVersion,
        model: config.knowledge.embedding.model,
        dimensions: config.knowledge.embedding.dimensions,
        timeoutMs: config.knowledge.embedding.timeoutMs
      })
    : undefined;
  if (knowledgeEmbedding) {
    void backfillAgentTextMemoryEmbeddings({
      store: memoryStore,
      embedding: knowledgeEmbedding,
      batchSize: config.knowledge?.embedding.batchSize ?? 20
    }).catch(() => undefined);
  }
  const notionKnowledge = config.knowledge
    ? createNotionKnowledgeClient(config.knowledge.notionToken)
    : undefined;
  const knowledgeAdminActionRegistry = createAdminActionRegistry({
    accessStore,
    registrationInviteCodeStore: registrationInviteCodeStore,
    registrationInviteCodeTtlMinutes: config.access?.registrationInviteCodeTtlMinutes ?? 60,
    confirmationStore,
    confirmationTtlMinutes: config.access?.confirmationTtlMinutes,
    knowledgeStore,
    notionKnowledge,
    knowledgeEmbedding,
    knowledgeEmbeddingBatchSize: config.knowledge?.embedding.batchSize
  });
  const webhookEventStore = createWebhookEventStore(redis);
  const agentJobStore = redis
    ? new RedisAgentJobStore({ client: redis.client, keyPrefix: redis.keyPrefix })
    : new InMemoryAgentJobStore();
  const attachmentScanWorkStore = redis
    ? new RedisAttachmentScanWorkStore({
        client: redis.client,
        keyPrefix: redis.keyPrefix,
        jobStore: agentJobStore
      })
    : new InMemoryAttachmentScanWorkStore({ jobStore: agentJobStore });
  const attachmentScanQueue = config.attachments.scanQueueUrl
    ? createAzureAttachmentScanQueue(config.attachments.scanQueueUrl)
    : undefined;
  const stopAttachmentScanOutbox =
    attachmentScanQueue && attachmentScanWorkStore.supportsDurableEnqueueRetry
      ? startAttachmentScanOutboxDispatcher({
          store: attachmentScanWorkStore,
          queue: attachmentScanQueue
        })
      : undefined;
  const stopMediaSyncOutbox =
    attachmentScanQueue && postgres?.mediaSyncStore
      ? startMediaSyncOutboxDispatcher({
          store: postgres.mediaSyncStore,
          queue: attachmentScanQueue
        })
      : undefined;
  const conversationWindowStore = redis
    ? new RedisConversationWindowStore({ client: redis.client, keyPrefix: redis.keyPrefix })
    : new InMemoryConversationWindowStore();
  const lastErrorStore = createLastErrorStore({
    redis,
    maxEntries: config.lastErrors?.maxEntries ?? 20
  });
  const lastRouteStore = createLastRouteStore({
    redis,
    maxEntries: config.lastErrors?.maxEntries ?? 20
  });
  const firstSuccessStore = createFirstSuccessStore(redis);
  const routeObserver = createConsoleRouteObserver();
  const completionObserver = createFunctionCompletionObserver({
    accessStore,
    routeObserver,
    firstSuccessStore,
    observabilityHmacKey: config.observability?.hmacKey
  });
  const rateLimiter = createRateLimiter({
    redis,
    config: config.rateLimit ?? { enabled: true, windowMs: 60_000, maxRequests: 20 }
  });
  const registries = createFunctionRegistries(
    config,
    {
      accountAdminClient,
      graph,
      notion,
      wikipedia,
      lineContent,
      sessionStore,
      cache,
      catalog,
      scheduleStore,
      knowledgeStore,
      embedding: knowledgeEmbedding,
      knowledgeTextGenerator: smartTalkPrimary,
      memoryStore,
      accessStore,
      agentJobStore,
      attachmentScanWorkStore,
      attachmentScanQueue,
      mediaSyncStore: postgres?.mediaSyncStore,
      webSearch,
      sheetMusicExternalSearchSummarizer: createSheetMusicExternalSearchSummarizer({
        primary: wikipediaSummaryPrimary
      }),
      wikipediaSummarizer: createWikipediaSummarizer({
        primary: wikipediaSummaryPrimary
      })
    },
    FUNCTION_MODULES.map((module) =>
      module.name === "query_schedule"
        ? createQueryScheduleModule({
            memoryStore,
            scheduleStore,
            notion,
            databaseId: config.notion?.databaseId,
            properties: config.notion?.properties,
            timeZone: config.timeZone,
            sessionStore
          })
        : module
    )
  );
  const applicationAgentRuntime = createAgentRuntime({ memoryStore, graph, accessStore });
  const directTurnRuntime = createAgentTurnRuntime({
    functionRegistry: registries.functions,
    textMessageHandlers: registries.textMessages,
    adminActionRouter,
    adminActionRegistry: knowledgeAdminActionRegistry,
    accessStore,
    sessionStore,
    agentRuntime: applicationAgentRuntime,
    traceStore: agentTraceStore,
    lastErrorStore,
    lastRouteStore,
    firstSuccessStore,
    routeObserver,
    completionObserver,
    observabilityHmacKey: config.observability?.hmacKey
  });
  const helperProfile = config.profiles.find(
    (profile) => profile.name === "helper" && profile.agent
  );
  let stopSdkStateCleanup: (() => void) | undefined;
  let agentTurnRuntime = directTurnRuntime;
  if (helperProfile) {
    let sdkState;
    if (postgres?.pool) {
      const checkpointer = new PostgresSaver(postgres.pool);
      await checkpointer.setup();
      const postgresState = createPostgresSdkAgentState({
        pool: postgres.pool,
        checkpointer,
        hmacKey: config.observability?.hmacKey ?? helperProfile.channelSecret,
        ttlMs: (helperProfile.agentRuntime?.taskFrameSeconds ?? 600) * 1000
      });
      await postgresState.setup();
      await postgresState.cleanupExpired();
      const timer = setInterval(
        () => void postgresState.cleanupExpired().catch(() => undefined),
        300_000
      );
      timer.unref();
      stopSdkStateCleanup = () => clearInterval(timer);
      sdkState = postgresState;
    } else {
      sdkState = createSdkAgentState({
        checkpointer: new MemorySaver(),
        hmacKey: config.observability?.hmacKey ?? helperProfile.channelSecret,
        ttlMs: (helperProfile.agentRuntime?.taskFrameSeconds ?? 600) * 1000
      });
    }
    agentTurnRuntime = createSdkAgentTurnRuntime({
      fallback: directTurnRuntime,
      functionRegistry: registries.functions,
      lastErrorStore,
      model: new ChatDeepSeek({
        apiKey: config.llm.deepseekApiKey,
        model: config.llm.deepseekModel,
        temperature: 0,
        maxRetries: 1,
        timeout: config.llm.deepseekTimeoutMs,
        configuration: { baseURL: config.llm.deepseekBaseUrl }
      }),
      state: sdkState,
      sessionStore,
      webSearch,
      pageReader: publicPageReader
    });
  }
  const app = createApp(config, {
    adminActionRegistry: knowledgeAdminActionRegistry,
    postbackHandlers: registries.postbacks,
    textMessageHandlers: registries.textMessages,
    adminHandlers: registries.adminHandlers,
    createLineReplyClient: createLineSdkReplyClient,
    createLineIdentityClient: createLineSdkIdentityClient,
    requestIdFactory: randomUUID,
    lastErrorStore,
    lastRouteStore,
    rateLimiter,
    accessStore,
    registrationInviteCodeStore,
    confirmationStore,
    webhookEventStore,
    sessionStore,
    agentTraceStore,
    agentJobStore,
    conversationWindowStore,
    textGenerator: smartTalkPrimary,
    agentRuntime: applicationAgentRuntime,
    agentTurnRuntime,
    diagnostics: createDependencyDiagnostics({
      config,
      postgres: postgres?.pool,
      redis: redis?.client
    }),
    routeObserver,
    completionObserver,
    accountAdminClient,
    mediaSyncStore: postgres?.mediaSyncStore,
    mediaSyncManagementService
  });

  return {
    app,
    async close() {
      clearInterval(memoryPurgeTimer);
      clearInterval(knowledgePurgeTimer);
      stopSdkStateCleanup?.();
      stopAttachmentScanOutbox?.();
      stopMediaSyncOutbox?.();
      await app.close();
      await redis?.close();
      await postgres?.pool.end();
    }
  };
}
import { randomUUID } from "node:crypto";
