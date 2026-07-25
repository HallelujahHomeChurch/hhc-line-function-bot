import { createAzureOpenAiEmbeddingClient } from "./clients/azure-openai-embedding.js";
import { createDeepSeekProvider } from "./clients/deepseek.js";
import { createAdminActionRouter } from "./admin-action-router.js";
import { RedisConfirmationStore } from "./actions/confirmation-store.js";
import { createAdminActionRegistry } from "./actions/admin-registry.js";
import { createAccessStore } from "./access/create-access-store.js";
import {
  InMemoryRegistrationInviteCodeStore,
  RedisRegistrationInviteCodeStore
} from "./access/registration-invite-code-store.js";
import { createAgentMemoryStore } from "./agent/create-agent-memory-store.js";
import { backfillAgentTextMemoryEmbeddings } from "./agent/text-memory-embedding-backfill.js";
import { createAgentRuntime } from "./agent/agent-runtime.js";
import { createAgentPlanner } from "./agent/planner.js";
import { createControlledAgentRouter } from "./agent/controlled-agent-router.js";
import {
  createCatalogEvidenceProvider,
  createCombinedEvidenceProvider,
  createMemoryEvidenceProvider,
  createResourceMemoryEvidenceProvider,
  createScheduleEvidenceProvider
} from "./agent/evidence/providers.js";
import { createWikipediaSummarizer } from "./wikipedia/summarizer.js";
import { InMemoryAgentJobStore, RedisAgentJobStore } from "./agent/jobs.js";
import { createAzureAttachmentScanQueue } from "./attachments/scan-queue.js";
import {
  InMemoryAttachmentScanWorkStore,
  RedisAttachmentScanWorkStore
} from "./attachments/scan-work-store.js";
import { startAttachmentScanOutboxDispatcher } from "./attachments/scan-outbox.js";
import { RedisConversationWindowStore } from "./agent/context-manager.js";
import { RedisAgentTraceStore } from "./agent/trace-store.js";
import { createCacheStore } from "./cache/create-cache-store.js";
import { createCatalogStore } from "./catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "./catalog/source-seeds.js";
import { createGraphDriveClient } from "./clients/graph.js";
import { createNotionDatabaseClient } from "./clients/notion.js";
import { createNotionKnowledgeClient } from "./clients/notion-knowledge.js";
import { createSearxngClient } from "./clients/searxng.js";
import { loadConfigFromEnv } from "./config.js";
import { createDependencyDiagnostics } from "./diagnostics/dependencies.js";
import { createPostgresRuntime } from "./db/postgres.js";
import { createFunctionRegistries } from "./functions/registry.js";
import { createInFlightStore } from "./in-flight/create-in-flight-store.js";
import { createWebhookEventStore } from "./idempotency/create-webhook-event-store.js";
import { createKnowledgeStore } from "./knowledge/create-store.js";
import { listKnowledgeRoutingMetadata } from "./knowledge/routing-metadata.js";
import { createKnowledgeRetrievalEvidenceProvider } from "./knowledge/retrieval-evidence.js";
import { createProfileAwareProvider } from "./llm/provider-runtime.js";
import { createLastErrorStore } from "./observability/create-last-error-store.js";
import { createLastRouteStore } from "./observability/create-last-route-store.js";
import { createConsoleRouteObserver } from "./observability/route-observer.js";
import { createRateLimiter } from "./rate-limit.js";
import { createRedisRuntime } from "./redis.js";
import { createScheduleStore } from "./schedules/create-schedule-store.js";
import { createSheetMusicExternalSearchSummarizer } from "./search/sheet-music-external-summarizer.js";
import { createApp } from "./server.js";
import { createSessionStore } from "./state/create-session-store.js";

const config = loadConfigFromEnv(process.env);

const redis = await createRedisRuntime(config.redis);
const postgres = await createPostgresRuntime(config.database);

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
const functionRoutingPrimary = createProfileAwareProvider({
  config,
  providers,
  role: "primary",
  lane: "function_routing"
});
const agentPlanner = createAgentPlanner({
  primary: functionRoutingPrimary
});
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
const webSearch = config.webSearch?.searxngBaseUrl
  ? createSearxngClient({
      baseUrl: config.webSearch.searxngBaseUrl,
      timeoutMs: config.webSearch.timeoutMs
    })
  : undefined;
const registrationInviteCodeStore = redis
  ? new RedisRegistrationInviteCodeStore({ client: redis.client, keyPrefix: redis.keyPrefix })
  : undefined;
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
  : undefined;
const cache = createCacheStore({ redis });
const catalog = await createCatalogStore({ db: postgres?.pool });
await seedCatalogSources({
  catalog,
  sources: buildCatalogSourceSeedsForProfiles(process.env, config.profiles)
});
const scheduleStore = await createScheduleStore({ db: postgres?.pool });
const knowledgeStore = await createKnowledgeStore({ db: postgres?.pool });
const controlledAgentRouter = createControlledAgentRouter({
  planner: agentPlanner,
  knowledgeMetadata: {
    async list(profileName, limit) {
      return listKnowledgeRoutingMetadata(knowledgeStore, profileName, limit);
    }
  },
  retrievalEvidenceProviders: {
    knowledge: createKnowledgeRetrievalEvidenceProvider(knowledgeStore),
    schedule: createScheduleEvidenceProvider(memoryStore),
    memory: createMemoryEvidenceProvider(memoryStore),
    catalog_presentation: createCombinedEvidenceProvider(
      createCatalogEvidenceProvider(catalog, {
        domains: ["presentation"],
        itemKinds: ["ppt_slide"]
      }),
      createResourceMemoryEvidenceProvider(memoryStore, ["ppt_slide"])
    ),
    catalog_sheet_music: createCombinedEvidenceProvider(
      createCatalogEvidenceProvider(catalog, { domains: ["sheet_music"] }),
      createResourceMemoryEvidenceProvider(memoryStore, ["sheet_music"])
    ),
    catalog_general: createCombinedEvidenceProvider(
      createCatalogEvidenceProvider(catalog, { domains: ["general", "audio"] }),
      createResourceMemoryEvidenceProvider(memoryStore, ["general_resource"])
    )
  }
});
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
  registrationInviteCodeStore:
    registrationInviteCodeStore ?? new InMemoryRegistrationInviteCodeStore(),
  registrationInviteCodeTtlMinutes: config.access?.registrationInviteCodeTtlMinutes ?? 60,
  confirmationStore,
  confirmationTtlMinutes: config.access?.confirmationTtlMinutes,
  knowledgeStore,
  notionKnowledge,
  knowledgeEmbedding,
  knowledgeEmbeddingBatchSize: config.knowledge?.embedding.batchSize
});
const inFlightStore = createInFlightStore({ redis });
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
if (attachmentScanQueue && attachmentScanWorkStore.supportsDurableEnqueueRetry) {
  startAttachmentScanOutboxDispatcher({
    store: attachmentScanWorkStore,
    queue: attachmentScanQueue
  });
}
const conversationWindowStore = redis
  ? new RedisConversationWindowStore({ client: redis.client, keyPrefix: redis.keyPrefix })
  : undefined;
const lastErrorStore = createLastErrorStore({
  redis,
  maxEntries: config.lastErrors?.maxEntries ?? 20
});
const lastRouteStore = createLastRouteStore({
  redis,
  maxEntries: config.lastErrors?.maxEntries ?? 20
});
const rateLimiter = createRateLimiter({
  redis,
  config: config.rateLimit ?? { enabled: true, windowMs: 60_000, maxRequests: 20 }
});
const registries = createFunctionRegistries(config, {
  graph,
  notion,
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
  webSearch,
  sheetMusicExternalSearchSummarizer: createSheetMusicExternalSearchSummarizer({
    primary: wikipediaSummaryPrimary
  }),
  wikipediaSummarizer: createWikipediaSummarizer({
    primary: wikipediaSummaryPrimary
  })
});
const app = createApp(config, {
  adminActionRouter,
  adminActionRegistry: knowledgeAdminActionRegistry,
  functionRegistry: registries.functions,
  postbackHandlers: registries.postbacks,
  textMessageHandlers: registries.textMessages,
  adminHandlers: registries.adminHandlers,
  lastErrorStore,
  lastRouteStore,
  rateLimiter,
  accessStore,
  registrationInviteCodeStore,
  confirmationStore,
  inFlightStore,
  webhookEventStore,
  sessionStore,
  agentTraceStore,
  agentJobStore,
  conversationWindowStore,
  controlledAgentRouter,
  textGenerator: smartTalkPrimary,
  agentRuntime: createAgentRuntime({ memoryStore, graph, accessStore }),
  diagnostics: createDependencyDiagnostics({
    config,
    postgres: postgres?.pool,
    redis: redis?.client
  }),
  routeObserver: createConsoleRouteObserver()
});

await app.listen({ host: config.host, port: config.port });
