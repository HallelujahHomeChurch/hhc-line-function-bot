import { createOllamaProvider } from "./clients/ollama.js";
import { createDeepSeekProvider } from "./clients/deepseek.js";
import { createAdminActionRouter } from "./admin-action-router.js";
import { RedisConfirmationStore } from "./actions/confirmation-store.js";
import { createAccessStore } from "./access/create-access-store.js";
import { RedisRegistrationInviteCodeStore } from "./access/registration-invite-code-store.js";
import { createAgentMemoryStore } from "./agent/create-agent-memory-store.js";
import { createAgentRuntime } from "./agent/agent-runtime.js";
import { createWikipediaSummarizer } from "./wikipedia/summarizer.js";
import { RedisAgentJobStore } from "./agent/jobs.js";
import { RedisConversationWindowStore } from "./agent/context-manager.js";
import { createCacheStore } from "./cache/create-cache-store.js";
import { createCatalogStore } from "./catalog/create-catalog-store.js";
import { createGraphDriveClient } from "./clients/graph.js";
import { createNotionDatabaseClient } from "./clients/notion.js";
import { loadConfigFromEnv } from "./config.js";
import { createDependencyDiagnostics } from "./diagnostics/dependencies.js";
import { createPostgresRuntime } from "./db/postgres.js";
import { createFunctionRegistries } from "./functions/registry.js";
import { createInFlightStore } from "./in-flight/create-in-flight-store.js";
import { createKeywordFallbackRouter } from "./keyword-router.js";
import { createProfileAwareProvider } from "./llm/provider-runtime.js";
import { createLastErrorStore } from "./observability/create-last-error-store.js";
import { createConsoleRouteObserver } from "./observability/route-observer.js";
import { createRateLimiter } from "./rate-limit.js";
import { createRedisRuntime } from "./redis.js";
import { createScheduleStore } from "./schedules/create-schedule-store.js";
import { createFunctionRouter } from "./router.js";
import { createApp } from "./server.js";
import { createSessionStore } from "./state/create-session-store.js";

const config = loadConfigFromEnv(process.env);

const redis = await createRedisRuntime(config.redis);
const postgres = await createPostgresRuntime(config.database);

const ollama = createOllamaProvider({
  baseUrl: config.llm.ollamaBaseUrl,
  model: config.llm.ollamaModel,
  timeoutMs: config.llm.timeoutMs,
  keepAlive: config.llm.ollamaKeepAlive
});
const providers = {
  ollama,
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
const functionRoutingFallback = createProfileAwareProvider({
  config,
  providers,
  role: "fallback",
  lane: "function_routing"
});
const adminRoutingPrimary = createProfileAwareProvider({
  config,
  providers,
  role: "primary",
  lane: "admin_routing"
});
const adminRoutingFallback = createProfileAwareProvider({
  config,
  providers,
  role: "fallback",
  lane: "admin_routing"
});
const smartTalkPrimary = createProfileAwareProvider({
  config,
  providers,
  role: "primary",
  lane: "smart_talk"
});
const smartTalkFallback = createProfileAwareProvider({
  config,
  providers,
  role: "fallback",
  lane: "smart_talk"
});
const wikipediaSummaryPrimary = createProfileAwareProvider({
  config,
  providers,
  role: "primary",
  lane: "web_summarization"
});
const wikipediaSummaryFallback = createProfileAwareProvider({
  config,
  providers,
  role: "fallback",
  lane: "web_summarization"
});
const router = createFunctionRouter({
  primary: functionRoutingPrimary,
  modelFallback: functionRoutingFallback,
  keywordFallback: createKeywordFallbackRouter(),
  keywordFallbackEnabled: config.llm.keywordFallbackEnabled,
  lane: "function_routing"
});
const adminActionRouter = createAdminActionRouter({
  primary: adminRoutingPrimary,
  modelFallback: adminRoutingFallback,
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
const registrationInviteCodeStore = redis
  ? new RedisRegistrationInviteCodeStore({ client: redis.client, keyPrefix: redis.keyPrefix })
  : undefined;
const confirmationStore = redis
  ? new RedisConfirmationStore({ client: redis.client, keyPrefix: redis.keyPrefix })
  : undefined;
const sessionStore = createSessionStore({ redis });
const cache = createCacheStore({ redis });
const catalog = await createCatalogStore({ db: postgres?.pool });
for (const source of config.catalog?.sources ?? []) {
  await catalog.upsertSource(source);
}
const scheduleStore = await createScheduleStore({ db: postgres?.pool });
const inFlightStore = createInFlightStore({ redis });
const agentJobStore = redis
  ? new RedisAgentJobStore({ client: redis.client, keyPrefix: redis.keyPrefix })
  : undefined;
const conversationWindowStore = redis
  ? new RedisConversationWindowStore({ client: redis.client, keyPrefix: redis.keyPrefix })
  : undefined;
const lastErrorStore = createLastErrorStore({
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
  memoryStore,
  wikipediaSummarizer: createWikipediaSummarizer({
    primary: wikipediaSummaryPrimary,
    fallback: wikipediaSummaryFallback
  })
});
const app = createApp(config, {
  router,
  adminActionRouter,
  functionRegistry: registries.functions,
  postbackHandlers: registries.postbacks,
  textMessageHandlers: registries.textMessages,
  adminHandlers: registries.adminHandlers,
  lastErrorStore,
  rateLimiter,
  accessStore,
  registrationInviteCodeStore,
  confirmationStore,
  inFlightStore,
  sessionStore,
  agentJobStore,
  conversationWindowStore,
  textGenerator: smartTalkPrimary,
  textFallbackGenerator: smartTalkFallback,
  agentRuntime: createAgentRuntime({ memoryStore, graph, accessStore }),
  diagnostics: createDependencyDiagnostics({
    config,
    postgres: postgres?.pool,
    redis: redis?.client
  }),
  routeObserver: createConsoleRouteObserver()
});

await app.listen({ host: config.host, port: config.port });
