import type { AppConfig, LineContentClient } from "../types.js";
import {
  createFunctionRegistries,
  type FunctionRegistries,
  type RegistryClients
} from "../functions/registry.js";
import { createTestRuntime } from "./create-test-runtime.js";

const unusedLineContent: LineContentClient = {
  async getMessageContent() {
    throw new Error("Test line content client was not configured");
  }
};

export function createTestFunctionRegistries(
  config: AppConfig,
  overrides: Partial<RegistryClients> = {}
): FunctionRegistries {
  const runtime = createTestRuntime();
  return createFunctionRegistries(config, {
    sessionStore: overrides.sessionStore ?? runtime.stores.session,
    cache: overrides.cache ?? runtime.stores.cache,
    memoryStore: overrides.memoryStore ?? runtime.stores.memory,
    catalog: overrides.catalog ?? runtime.stores.catalog,
    knowledgeStore: overrides.knowledgeStore ?? runtime.stores.knowledge,
    scheduleStore: overrides.scheduleStore ?? runtime.stores.schedule,
    lineContent: overrides.lineContent ?? unusedLineContent,
    graph: overrides.graph,
    notion: overrides.notion,
    wikipedia: overrides.wikipedia,
    wikipediaSummarizer: overrides.wikipediaSummarizer,
    webSearch: overrides.webSearch,
    sheetMusicExternalSearchSummarizer: overrides.sheetMusicExternalSearchSummarizer,
    embedding: overrides.embedding,
    knowledgeTextGenerator: overrides.knowledgeTextGenerator,
    accessStore: overrides.accessStore,
    agentJobStore: overrides.agentJobStore,
    attachmentScanQueue: overrides.attachmentScanQueue,
    attachmentScanWorkStore: overrides.attachmentScanWorkStore,
    now: overrides.now,
    requestIdFactory: overrides.requestIdFactory,
    fetchImpl: overrides.fetchImpl
  });
}
