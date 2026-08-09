import type { AgentJobStore } from "../../agent/jobs.js";
import type { AccountAdminClient } from "../../account/account-admin-client.js";
import type { AgentMemoryStore } from "../../agent/memory-store.js";
import type { AttachmentScanQueue } from "../../attachments/scan-queue.js";
import type { AttachmentScanWorkStore } from "../../attachments/scan-work-store.js";
import type { CacheStore } from "../../cache/cache-store.js";
import type { CatalogStore } from "../../catalog/store.js";
import type { EmbeddingClient } from "../../clients/embedding.js";
import type { KnowledgeStore } from "../../knowledge/store.js";
import type { ScheduleStore } from "../../schedules/store.js";
import type { SheetMusicExternalSearchSummarizer } from "../../search/sheet-music-external-summarizer.js";
import type { SessionStore } from "../../state/session-store.js";
import type {
  AppConfig,
  FunctionName,
  GraphDriveClient,
  JsonRecord,
  LineContentClient,
  NotionDatabaseClient,
  TextGenerationProvider,
  WebSearchClient
} from "../../types.js";
import type { WikipediaClient } from "../../wikipedia/client.js";
import type { WikipediaSummarizer } from "../../wikipedia/lookup.js";
import type {
  AdminHandlerRegistry,
  FunctionRegistry,
  PostbackHandlerRegistry,
  TextMessageHandlerRegistry
} from "./function-execution.js";

export interface FunctionModuleDefinition {
  name: FunctionName;
  displayName: string;
  shortDescription: string;
  argumentSchema: unknown;
  sideEffectLevel: string;
  agentCapability?: unknown;
}

export interface FunctionModuleRegistrations {
  functions?: FunctionRegistry;
  postbacks?: PostbackHandlerRegistry;
  textMessages?: TextMessageHandlerRegistry;
  adminHandlers?: AdminHandlerRegistry;
}

export interface RouterEvalCase {
  kind: "positive" | "missing_slot" | "typo" | "negative" | "disabled" | "cross_function";
  text: string;
  enabledFunctions?: FunctionName[];
  expected:
    | {
        type: "execute";
        action: FunctionName;
        arguments: JsonRecord;
      }
    | {
        type: "deny";
        reason: string;
      };
}

export interface FunctionModuleContext {
  config: AppConfig;
  clients: {
    accountAdminClient?: AccountAdminClient;
    graph?: GraphDriveClient;
    notion?: NotionDatabaseClient;
    sessionStore: SessionStore;
    cache: CacheStore;
    memoryStore?: AgentMemoryStore;
    catalog?: CatalogStore;
    scheduleStore?: ScheduleStore;
    lineContent?: LineContentClient;
    wikipedia?: WikipediaClient;
    wikipediaSummarizer?: WikipediaSummarizer;
    webSearch?: WebSearchClient;
    sheetMusicExternalSearchSummarizer?: SheetMusicExternalSearchSummarizer;
    knowledgeStore?: KnowledgeStore;
    embedding?: EmbeddingClient;
    knowledgeTextGenerator?: TextGenerationProvider;
    agentJobStore?: AgentJobStore;
    attachmentScanQueue?: AttachmentScanQueue;
    attachmentScanWorkStore?: AttachmentScanWorkStore;
    now?: () => Date;
    requestIdFactory?: () => string;
    fetchImpl?: typeof fetch;
  };
}

export interface FunctionModule {
  name: FunctionName;
  definition: FunctionModuleDefinition;
  routerEvalCases: RouterEvalCase[];
  register(context: FunctionModuleContext): FunctionModuleRegistrations;
}
