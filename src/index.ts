import { createAzureOpenAIProvider } from "./clients/azure-openai.js";
import { createOllamaProvider } from "./clients/ollama.js";
import { loadConfigFromEnv } from "./config.js";
import { createFunctionRegistry } from "./functions/registry.js";
import { createFunctionRouter } from "./router.js";
import { createApp } from "./server.js";

const config = loadConfigFromEnv(process.env);

const primary = createOllamaProvider({
  baseUrl: config.llm.ollamaBaseUrl,
  model: config.llm.ollamaModel,
  timeoutMs: config.llm.timeoutMs,
  keepAlive: config.llm.ollamaKeepAlive
});
const fallback = config.azureOpenAI ? createAzureOpenAIProvider(config.azureOpenAI) : undefined;
const router = createFunctionRouter({
  primary,
  fallback,
  fallbackEnabled: config.llm.azureFallbackEnabled && Boolean(fallback)
});
const functionRegistry = createFunctionRegistry(config);
const app = createApp(config, { router, functionRegistry });

await app.listen({ host: config.host, port: config.port });
