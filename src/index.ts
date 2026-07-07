import { createOllamaProvider } from "./clients/ollama.js";
import { createAccessStore } from "./access/create-access-store.js";
import { RedisRegistrationInviteCodeStore } from "./access/registration-invite-code-store.js";
import { createCacheStore } from "./cache/create-cache-store.js";
import { loadConfigFromEnv } from "./config.js";
import { createPostgresRuntime } from "./db/postgres.js";
import { createFunctionRegistries } from "./functions/registry.js";
import { createKeywordFallbackRouter } from "./keyword-router.js";
import { createLastErrorStore } from "./observability/create-last-error-store.js";
import { createConsoleRouteObserver } from "./observability/route-observer.js";
import { createRateLimiter } from "./rate-limit.js";
import { createRedisRuntime } from "./redis.js";
import { createFunctionRouter } from "./router.js";
import { createApp } from "./server.js";
import { createSessionStore } from "./state/create-session-store.js";

const config = loadConfigFromEnv(process.env);

const primary = createOllamaProvider({
  baseUrl: config.llm.ollamaBaseUrl,
  model: config.llm.ollamaModel,
  timeoutMs: config.llm.timeoutMs,
  keepAlive: config.llm.ollamaKeepAlive
});
const router = createFunctionRouter({
  primary,
  keywordFallback: createKeywordFallbackRouter(),
  keywordFallbackEnabled: config.llm.keywordFallbackEnabled
});
const redis = await createRedisRuntime(config.redis);
const postgres = await createPostgresRuntime(config.database);
const accessStore = await createAccessStore({ db: postgres?.pool });
const registrationInviteCodeStore = redis
  ? new RedisRegistrationInviteCodeStore({ client: redis.client, keyPrefix: redis.keyPrefix })
  : undefined;
const sessionStore = createSessionStore({ redis });
const cache = createCacheStore({ redis });
const lastErrorStore = createLastErrorStore({
  redis,
  maxEntries: config.lastErrors?.maxEntries ?? 20
});
const rateLimiter = createRateLimiter({
  redis,
  config: config.rateLimit ?? { enabled: true, windowMs: 60_000, maxRequests: 20 }
});
const registries = createFunctionRegistries(config, { sessionStore, cache });
const app = createApp(config, {
  router,
  functionRegistry: registries.functions,
  postbackHandlers: registries.postbacks,
  textMessageHandlers: registries.textMessages,
  adminHandlers: registries.adminHandlers,
  lastErrorStore,
  rateLimiter,
  accessStore,
  registrationInviteCodeStore,
  routeObserver: createConsoleRouteObserver()
});

await app.listen({ host: config.host, port: config.port });
