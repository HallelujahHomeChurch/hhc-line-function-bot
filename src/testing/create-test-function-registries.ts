import type { AppConfig } from "../types.js";
import {
  composeCapabilities,
  type CapabilityComposition,
  type CapabilityCompositionDependencies
} from "../bootstrap/compose-capabilities.js";
import { createTestRuntime } from "./create-test-runtime.js";

export function createTestFunctionRegistries(
  config: AppConfig,
  overrides: Partial<CapabilityCompositionDependencies> = {}
): CapabilityComposition {
  const runtime = createTestRuntime();
  return composeCapabilities(config, {
    accountAdminClient: overrides.accountAdminClient,
    sessionStore: overrides.sessionStore ?? runtime.stores.session,
    cache: overrides.cache ?? runtime.stores.cache,
    memoryStore: overrides.memoryStore ?? runtime.stores.memory,
    catalog: overrides.catalog ?? runtime.stores.catalog,
    knowledgeStore: overrides.knowledgeStore ?? runtime.stores.knowledge,
    scheduleStore: overrides.scheduleStore ?? runtime.stores.schedule,
    graph: overrides.graph,
    notion: overrides.notion,
    wikipedia: overrides.wikipedia,
    wikipediaSummarizer: overrides.wikipediaSummarizer,
    embedding: overrides.embedding,
    knowledgeTextGenerator: overrides.knowledgeTextGenerator,
    accessStore: overrides.accessStore,
    agentJobStore: overrides.agentJobStore,
    attachmentScanQueue: overrides.attachmentScanQueue,
    attachmentScanWorkStore: overrides.attachmentScanWorkStore,
    now: overrides.now,
    requestIdFactory: overrides.requestIdFactory,
    fetchImpl: overrides.fetchImpl,
    externalResearchEnabled: overrides.externalResearchEnabled
  });
}
