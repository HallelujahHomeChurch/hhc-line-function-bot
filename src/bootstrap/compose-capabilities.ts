import type { ReadMeetingOccurrences } from "../clients/meeting-occurrences.js";
import type { AccountAdminClient } from "../account/account-admin-client.js";
import type { AccessStore } from "../access/types.js";
import type { AgentJobStore } from "../agent/jobs.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
import type { AttachmentScanQueue } from "../attachments/scan-queue.js";
import type { AttachmentScanWorkStore } from "../attachments/scan-work-store.js";
import type { CacheStore } from "../cache/cache-store.js";
import { downloadWeeklyPaper } from "../capabilities/download-weekly-paper.js";
import { createQueryScheduleHandler } from "../capabilities/query-schedule/handler.js";
import { createUpdateOwnProfileHandler } from "../capabilities/update-own-profile/handler.js";
import { createCatalogAdminHandlers } from "../catalog/admin-handlers.js";
import type { CatalogStore } from "../catalog/store.js";
import type { EmbeddingClient } from "../clients/embedding.js";
import {
  createRetrieveMemoryHandler,
  createSaveMemoryHandler
} from "../functions/agent-memory-functions.js";
import {
  createExternalSheetMusicImportTextMessageHandler,
  createFindPopSheetMusicHandler,
  createFindPopSheetMusicPostbackHandler,
  createFindPopSheetMusicTextMessageHandler
} from "../functions/find-pop-sheet-music.js";
import {
  createFindPptSlidesHandler,
  createFindPptSlidesPostbackHandler,
  createFindPptSlidesTextMessageHandler
} from "../functions/find-ppt-slides.js";
import { createFindResourceHandler } from "../functions/find-resource.js";
import {
  createQueryKnowledgeHandler,
  createQueryKnowledgePostbackHandler,
  createQueryKnowledgeTextMessageHandler
} from "../functions/query-knowledge.js";
import { createSaveResourceHandler } from "../functions/save-resource.js";
import { createSaveScheduleHandler } from "../functions/schedule-memory.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { createLlmStatusAdminHandler } from "../llm-diagnostics.js";
import type { PostgresMediaSyncStore } from "../media-sync/store.js";
import type { ScheduleStore } from "../schedules/store.js";
import type { SessionStore } from "../state/session-store.js";
import {
  createPendingAttachmentTextMessageHandler,
  createUploadIntentTextMessageHandler
} from "../transport/line/attachment-intake.js";
import type {
  AdminHandlerRegistry,
  AppConfig,
  FunctionRegistry,
  GraphDriveClient,
  NotionDatabaseClient,
  PostbackHandlerRegistry,
  TextGenerationProvider,
  TextMessageHandler,
  TextMessageHandlerRegistry
} from "../types.js";
import type { WikipediaClient } from "../wikipedia/client.js";
import { createWikipediaLookupHandler, type WikipediaSummarizer } from "../wikipedia/lookup.js";

export interface CapabilityCompositionDependencies {
  readMeetingOccurrences?: ReadMeetingOccurrences;
  accountAdminClient?: AccountAdminClient;
  accessStore?: AccessStore;
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
  wikipedia?: WikipediaClient;
  wikipediaSummarizer?: WikipediaSummarizer;
  sessionStore: SessionStore;
  cache: CacheStore;
  memoryStore: AgentMemoryStore;
  catalog: CatalogStore;
  scheduleStore: ScheduleStore;
  knowledgeStore: KnowledgeStore;
  embedding?: EmbeddingClient;
  knowledgeTextGenerator?: TextGenerationProvider;
  agentJobStore?: AgentJobStore;
  attachmentScanQueue?: AttachmentScanQueue;
  attachmentScanWorkStore?: AttachmentScanWorkStore;
  mediaSyncStore?: PostgresMediaSyncStore;
  now?: () => Date;
  requestIdFactory?: () => string;
  fetchImpl?: typeof fetch;
  externalResearchEnabled?: boolean;
}

export interface CapabilityComposition {
  functions: FunctionRegistry;
  postbacks: PostbackHandlerRegistry;
  textMessages: TextMessageHandlerRegistry;
  attachmentTextHandlers: TextMessageHandler[];
  adminHandlers: AdminHandlerRegistry;
}

export function composeCapabilities(
  config: AppConfig,
  clients: CapabilityCompositionDependencies
): CapabilityComposition {
  const functions: FunctionRegistry = {
    download_weekly_paper: (args) => downloadWeeklyPaper(args, clients.fetchImpl ?? fetch),
    update_own_profile: createUpdateOwnProfileHandler({
      accountClient: clients.accountAdminClient ?? missingAccountClient()
    }),
    query_schedule: createQueryScheduleHandler({
      readMeetingOccurrences: clients.readMeetingOccurrences,
      memoryStore: clients.memoryStore,
      scheduleStore: clients.scheduleStore,
      notion: clients.notion,
      databaseId: config.notion?.databaseId,
      properties: config.notion?.properties,
      timeZone: config.timeZone,
      now: clients.now
    }),
    query_knowledge: createQueryKnowledgeHandler({
      store: clients.knowledgeStore,
      embedding: clients.embedding,
      textGenerator: clients.knowledgeTextGenerator,
      now: clients.now,
      requestIdFactory: clients.requestIdFactory
    }),
    save_schedule: createSaveScheduleHandler({
      memoryStore: clients.memoryStore,
      now: clients.now
    }),
    save_memory: createSaveMemoryHandler({
      memoryStore: clients.memoryStore,
      now: clients.now,
      embedding: clients.embedding
    }),
    save_resource: createSaveResourceHandler({
      memoryStore: clients.memoryStore,
      now: clients.now
    }),
    retrieve_memory: createRetrieveMemoryHandler({
      memoryStore: clients.memoryStore,
      now: clients.now,
      embedding: clients.embedding,
      textGenerator: clients.knowledgeTextGenerator
    })
  };

  if (config.graph && clients.graph) {
    functions.find_ppt_slides = createFindPptSlidesHandler({
      graph: clients.graph,
      catalog: clients.catalog,
      driveId: config.graph.driveId,
      folderItemId: config.graph.pptFolderItemId,
      allowedExtensions: config.graph.allowedExtensions,
      defaultIncludePdf: config.graph.defaultIncludePdf,
      memoryStore: clients.memoryStore,
      sessionStore: clients.sessionStore,
      now: clients.now,
      observabilityHmacKey: config.observability?.hmacKey,
      requestIdFactory: clients.requestIdFactory
    });
    functions.find_sheet_music = createFindPopSheetMusicHandler({
      graph: clients.graph,
      catalog: clients.catalog,
      driveId: config.graph.driveId,
      allowedExtensions: config.graph.sheetMusicAllowedExtensions,
      memoryStore: clients.memoryStore,
      sessionStore: clients.sessionStore,
      externalResearchEnabled: clients.externalResearchEnabled,
      now: clients.now,
      requestIdFactory: clients.requestIdFactory
    });
    functions.find_resource = createFindResourceHandler({
      catalog: clients.catalog,
      graph: clients.graph,
      allowedItemKinds: ["church_document", "church_image", "church_other", "weekly_report_audio"],
      now: clients.now
    });
  }
  if (clients.wikipedia && clients.wikipediaSummarizer) {
    functions.query_wikipedia = createWikipediaLookupHandler({
      client: clients.wikipedia,
      summarize: clients.wikipediaSummarizer
    });
  }

  const postbacks: PostbackHandlerRegistry = {};
  const textMessages: TextMessageHandlerRegistry = {};
  if (clients.graph) {
    postbacks.select_ppt = {
      capability: "find_ppt_slides",
      handle: createFindPptSlidesPostbackHandler({
        graph: clients.graph,
        sessionStore: clients.sessionStore,
        now: clients.now
      })
    };
    postbacks.select_sheet_music = {
      capability: "find_sheet_music",
      handle: createFindPopSheetMusicPostbackHandler({
        graph: clients.graph,
        sessionStore: clients.sessionStore,
        now: clients.now
      })
    };
    textMessages.ppt_numeric_selection = createFindPptSlidesTextMessageHandler({
      graph: clients.graph,
      sessionStore: clients.sessionStore,
      now: clients.now
    });
    textMessages.sheet_music_numeric_selection = createFindPopSheetMusicTextMessageHandler({
      graph: clients.graph,
      sessionStore: clients.sessionStore,
      catalog: clients.catalog,
      agentJobStore: clients.agentJobStore,
      scanQueue: clients.attachmentScanQueue,
      scanWorkStore: clients.attachmentScanWorkStore,
      now: clients.now
    });
    textMessages.external_sheet_music_import = createExternalSheetMusicImportTextMessageHandler({
      graph: clients.graph,
      sessionStore: clients.sessionStore,
      catalog: clients.catalog,
      agentJobStore: clients.agentJobStore,
      scanQueue: clients.attachmentScanQueue,
      scanWorkStore: clients.attachmentScanWorkStore,
      now: clients.now
    });
  }
  postbacks.select_knowledge_source = {
    capability: "query_knowledge",
    handle: createQueryKnowledgePostbackHandler({
      store: clients.knowledgeStore,
      embedding: clients.embedding,
      textGenerator: clients.knowledgeTextGenerator,
      sessionStore: clients.sessionStore,
      now: clients.now,
      requestIdFactory: clients.requestIdFactory
    })
  };
  textMessages.knowledge_numeric_selection = createQueryKnowledgeTextMessageHandler({
    store: clients.knowledgeStore,
    embedding: clients.embedding,
    textGenerator: clients.knowledgeTextGenerator,
    sessionStore: clients.sessionStore,
    now: clients.now,
    requestIdFactory: clients.requestIdFactory
  });

  const attachmentTextHandlers: TextMessageHandler[] = [];
  if (clients.agentJobStore && clients.attachmentScanQueue && clients.attachmentScanWorkStore) {
    attachmentTextHandlers.push(
      createUploadIntentTextMessageHandler({
        sessionStore: clients.sessionStore,
        now: clients.now,
        requestIdFactory: clients.requestIdFactory
      }),
      createPendingAttachmentTextMessageHandler({
        sessionStore: clients.sessionStore,
        catalog: clients.catalog,
        agentJobStore: clients.agentJobStore,
        scanQueue: clients.attachmentScanQueue,
        scanWorkStore: clients.attachmentScanWorkStore,
        mediaSyncStore: clients.mediaSyncStore,
        now: clients.now
      })
    );
  }

  const adminHandlers: AdminHandlerRegistry = {
    functions: ({ profile }) => ({
      ok: true,
      replyText: [
        "Enabled functions",
        `profile: ${profile.name}`,
        ...profile.enabledFunctions.map(
          (name) => `- ${name}: ${functions[name] ? "configured" : "not configured"}`
        )
      ].join("\n")
    }),
    sessions: async () => {
      const summary = await clients.sessionStore.summary();
      const byType = Object.entries(summary.byType).map(([type, count]) => `- ${type}: ${count}`);
      return {
        ok: true,
        replyText: [
          "Sessions",
          `total: ${summary.total}`,
          ...(byType.length ? byType : ["- none"])
        ].join("\n")
      };
    },
    "clear-sessions": async () => ({
      ok: true,
      replyText: `已清除 session（${await clients.sessionStore.clear()} 筆）。`
    }),
    cache: async () => ({
      ok: true,
      replyText: ["Cache", `entries: ${(await clients.cache.stats()).totalEntries}`].join("\n")
    }),
    "llm-status": createLlmStatusAdminHandler(config.llm, { fetchImpl: clients.fetchImpl })
  };
  Object.assign(
    adminHandlers,
    createCatalogAdminHandlers({
      config,
      catalog: clients.catalog,
      accessStore: clients.accessStore,
      graph: clients.graph,
      notion: clients.notion,
      schedules: clients.scheduleStore
    })
  );
  return { functions, postbacks, textMessages, attachmentTextHandlers, adminHandlers };
}

function missingAccountClient(): AccountAdminClient {
  return {
    async verifyPermission() {
      return false;
    },
    async authorizeAdministrator() {
      return { bound: false, allowed: false };
    },
    async authorizeFunctions() {
      return { bound: false, active: false, administrator: false, allowedFunctions: [] };
    },
    async verifyFunctionPermissions() {
      return [];
    },
    async createBinding() {
      throw new Error("account_client_not_configured");
    },
    async finalizeBinding() {
      throw new Error("account_client_not_configured");
    },
    async updateOwnProfile() {
      throw new Error("account_client_not_configured");
    }
  };
}
