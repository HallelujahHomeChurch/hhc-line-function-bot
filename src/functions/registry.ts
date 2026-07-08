import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { InMemoryAgentMemoryStore, type AgentMemoryStore } from "../agent/memory-store.js";
import { MemoryCacheStore, type CacheStore } from "../cache/cache-store.js";
import { createLlmStatusAdminHandler } from "../llm-diagnostics.js";
import { InMemorySessionStore, type SessionStore } from "../state/session-store.js";
import type {
  AppConfig,
  AdminHandlerRegistry,
  FunctionRegistry,
  GraphDriveClient,
  NotionDatabaseClient,
  PostbackHandlerRegistry,
  TextMessageHandlerRegistry
} from "../types.js";
import { FUNCTION_MODULES } from "./modules.js";
import { createPendingFunctionTextMessageHandler } from "./pending-function.js";

export interface RegistryClients {
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
  sessionStore?: SessionStore;
  cache?: CacheStore;
  memoryStore?: AgentMemoryStore;
  now?: () => Date;
  requestIdFactory?: () => string;
  fetchImpl?: typeof fetch;
}

export interface FunctionRegistries {
  functions: FunctionRegistry;
  postbacks: PostbackHandlerRegistry;
  textMessages: TextMessageHandlerRegistry;
  adminHandlers: AdminHandlerRegistry;
}

export function createFunctionRegistries(
  config: AppConfig,
  clients: RegistryClients = {}
): FunctionRegistries {
  const functions: FunctionRegistry = {};
  const postbacks: PostbackHandlerRegistry = {};
  const textMessages: TextMessageHandlerRegistry = {};
  const adminHandlers: AdminHandlerRegistry = {};
  const sessionStore = clients.sessionStore ?? new InMemorySessionStore();
  const cache = clients.cache ?? new MemoryCacheStore();
  const memoryStore = clients.memoryStore ?? new InMemoryAgentMemoryStore({ now: clients.now });

  const moduleContext = {
    config,
    clients: {
      graph: config.graph ? (clients.graph ?? createGraphDriveClient(config.graph)) : undefined,
      notion: config.notion
        ? (clients.notion ?? createNotionDatabaseClient(config.notion))
        : undefined,
      sessionStore,
      cache,
      memoryStore,
      now: clients.now,
      requestIdFactory: clients.requestIdFactory
    }
  };

  for (const module of FUNCTION_MODULES) {
    const registrations = module.register(moduleContext);
    Object.assign(functions, registrations.functions);
    Object.assign(postbacks, registrations.postbacks);
    Object.assign(textMessages, registrations.textMessages);
    Object.assign(adminHandlers, registrations.adminHandlers);
  }

  if (Object.keys(functions).length > 0) {
    textMessages.pending_function_answer = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions
    });
  }

  adminHandlers.functions = ({ profile }) => ({
    ok: true,
    replyText: [
      "Enabled functions",
      `profile: ${profile.name}`,
      ...profile.enabledFunctions.map(
        (name) => `- ${name}: ${functions[name] ? "configured" : "not configured"}`
      )
    ].join("\n")
  });

  adminHandlers.sessions = async () => {
    const summary = await sessionStore.summary();
    const byType = Object.entries(summary.byType).map(([type, count]) => `- ${type}: ${count}`);
    return {
      ok: true,
      replyText: [
        "Sessions",
        `total: ${summary.total}`,
        ...(byType.length ? byType : ["- none"])
      ].join("\n")
    };
  };

  adminHandlers["clear-sessions"] = async () => {
    const removed = await sessionStore.clear();
    return {
      ok: true,
      replyText: `已清除 session（${removed} 筆）。`
    };
  };

  adminHandlers.cache = async () => {
    const stats = await cache.stats();
    return {
      ok: true,
      replyText: ["Cache", `entries: ${stats.totalEntries}`].join("\n")
    };
  };

  adminHandlers["llm-status"] = createLlmStatusAdminHandler(config.llm, {
    fetchImpl: clients.fetchImpl
  });

  return { functions, postbacks, textMessages, adminHandlers };
}

export function createFunctionRegistry(
  config: AppConfig,
  clients: RegistryClients = {}
): FunctionRegistry {
  return createFunctionRegistries(config, clients).functions;
}
