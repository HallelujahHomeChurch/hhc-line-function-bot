import { createOllamaProvider } from "./clients/ollama.js";
import { loadConfigFromEnv } from "./config.js";
import { createFunctionRegistries } from "./functions/registry.js";
import { createKeywordFallbackRouter } from "./keyword-router.js";
import { createFunctionRouter } from "./router.js";
import { createApp } from "./server.js";

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
const registries = createFunctionRegistries(config);
const app = createApp(config, {
  router,
  functionRegistry: registries.functions,
  postbackHandlers: registries.postbacks,
  textMessageHandlers: registries.textMessages,
  adminHandlers: registries.adminHandlers
});

await app.listen({ host: config.host, port: config.port });
