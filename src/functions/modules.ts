import type {
  FunctionModule,
  FunctionModuleContext,
  FunctionModuleRegistrations
} from "../application/contracts/function-module.js";
import type { FunctionName } from "../types.js";
import { getFunctionDefinition, type FunctionDefinition } from "./definitions.js";
import {
  createFindPptSlidesHandler,
  createFindPptSlidesPostbackHandler,
  createFindPptSlidesTextMessageHandler
} from "./find-ppt-slides.js";
import {
  createExternalSheetMusicImportTextMessageHandler,
  createFindPopSheetMusicHandler,
  createFindPopSheetMusicPostbackHandler,
  createFindPopSheetMusicTextMessageHandler
} from "./find-pop-sheet-music.js";
import { queryScheduleModule } from "../capabilities/query-schedule/module.js";
import { createWikipediaLookupHandler } from "../wikipedia/lookup.js";
import { createRetrieveMemoryHandler, createSaveMemoryHandler } from "./agent-memory-functions.js";
import {
  createPendingAttachmentTextMessageHandler,
  createUploadIntentTextMessageHandler
} from "../transport/line/attachment-intake.js";
import { createFindResourceHandler } from "./find-resource.js";
import { createSaveResourceHandler } from "./save-resource.js";
import {
  createQueryKnowledgeHandler,
  createQueryKnowledgePostbackHandler,
  createQueryKnowledgeTextMessageHandler
} from "./query-knowledge.js";
import { createSaveScheduleHandler } from "./schedule-memory.js";
import { downloadWeeklyPaperModule } from "../capabilities/download-weekly-paper.js";
import { updateOwnProfileModule } from "../capabilities/update-own-profile/module.js";

export type { FunctionModule, FunctionModuleContext, FunctionModuleRegistrations };

export const FUNCTION_MODULES: FunctionModule[] = [
  downloadWeeklyPaperModule,
  updateOwnProfileModule,
  {
    name: "find_ppt_slides",
    definition: requiredDefinition("find_ppt_slides"),
    register: ({ config, clients }) => {
      if (!config.graph || !clients.graph) {
        return {};
      }
      return {
        functions: {
          find_ppt_slides: createFindPptSlidesHandler({
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
          })
        },
        postbacks: {
          select_ppt: {
            capability: "find_ppt_slides",
            handle: createFindPptSlidesPostbackHandler({
              graph: clients.graph,
              sessionStore: clients.sessionStore,
              now: clients.now
            })
          }
        },
        textMessages: {
          ppt_numeric_selection: createFindPptSlidesTextMessageHandler({
            graph: clients.graph,
            sessionStore: clients.sessionStore,
            now: clients.now
          })
        }
      };
    }
  },
  queryScheduleModule,
  {
    name: "query_knowledge",
    definition: requiredDefinition("query_knowledge"),
    register: ({ clients }) =>
      clients.knowledgeStore
        ? {
            functions: {
              query_knowledge: createQueryKnowledgeHandler({
                store: clients.knowledgeStore,
                embedding: clients.embedding,
                textGenerator: clients.knowledgeTextGenerator,
                sessionStore: clients.sessionStore,
                now: clients.now,
                requestIdFactory: clients.requestIdFactory
              })
            },
            postbacks: {
              select_knowledge_source: {
                capability: "query_knowledge",
                handle: createQueryKnowledgePostbackHandler({
                  store: clients.knowledgeStore,
                  embedding: clients.embedding,
                  textGenerator: clients.knowledgeTextGenerator,
                  sessionStore: clients.sessionStore,
                  now: clients.now,
                  requestIdFactory: clients.requestIdFactory
                })
              }
            },
            textMessages: {
              knowledge_numeric_selection: createQueryKnowledgeTextMessageHandler({
                store: clients.knowledgeStore,
                embedding: clients.embedding,
                textGenerator: clients.knowledgeTextGenerator,
                sessionStore: clients.sessionStore,
                now: clients.now,
                requestIdFactory: clients.requestIdFactory
              })
            }
          }
        : {}
  },
  {
    name: "save_schedule",
    definition: requiredDefinition("save_schedule"),
    register: ({ clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      return {
        functions: {
          save_schedule: createSaveScheduleHandler({
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
          })
        }
      };
    }
  },
  {
    name: "find_sheet_music",
    definition: requiredDefinition("find_sheet_music"),
    register: ({ config, clients }) => {
      if (!config.graph || !clients.graph) {
        return {};
      }
      return {
        functions: {
          find_sheet_music: createFindPopSheetMusicHandler({
            graph: clients.graph,
            catalog: clients.catalog,
            driveId: config.graph.driveId,
            allowedExtensions: config.graph.sheetMusicAllowedExtensions,
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            externalSearch:
              clients.webSearch && clients.sheetMusicExternalSearchSummarizer
                ? {
                    webSearch: clients.webSearch,
                    summarize: clients.sheetMusicExternalSearchSummarizer
                  }
                : undefined,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory,
            functionName: "find_sheet_music"
          })
        },
        postbacks: {
          select_sheet_music: {
            capability: "find_sheet_music",
            handle: createFindPopSheetMusicPostbackHandler({
              graph: clients.graph,
              sessionStore: clients.sessionStore,
              now: clients.now
            })
          }
        },
        textMessages: {
          external_sheet_music_import: createExternalSheetMusicImportTextMessageHandler({
            graph: clients.graph,
            sessionStore: clients.sessionStore,
            catalog: clients.catalog,
            agentJobStore: clients.agentJobStore,
            scanQueue: clients.attachmentScanQueue,
            scanWorkStore: clients.attachmentScanWorkStore,
            externalSearch:
              clients.webSearch && clients.sheetMusicExternalSearchSummarizer
                ? {
                    webSearch: clients.webSearch,
                    summarize: clients.sheetMusicExternalSearchSummarizer
                  }
                : undefined,
            now: clients.now
          }),
          sheet_music_numeric_selection: createFindPopSheetMusicTextMessageHandler({
            graph: clients.graph,
            sessionStore: clients.sessionStore,
            catalog: clients.catalog,
            agentJobStore: clients.agentJobStore,
            scanQueue: clients.attachmentScanQueue,
            scanWorkStore: clients.attachmentScanWorkStore,
            externalSearch:
              clients.webSearch && clients.sheetMusicExternalSearchSummarizer
                ? {
                    webSearch: clients.webSearch,
                    summarize: clients.sheetMusicExternalSearchSummarizer
                  }
                : undefined,
            now: clients.now
          })
        }
      };
    }
  },
  {
    name: "find_resource",
    definition: requiredDefinition("find_resource"),
    register: ({ clients }) => {
      if (!clients.catalog || !clients.graph) {
        return {};
      }
      return {
        functions: {
          find_resource: createFindResourceHandler({
            catalog: clients.catalog,
            graph: clients.graph,
            allowedItemKinds: [
              "church_document",
              "church_image",
              "church_other",
              "weekly_report_audio"
            ],
            now: clients.now
          })
        }
      };
    }
  },
  {
    name: "query_wikipedia",
    definition: requiredDefinition("query_wikipedia"),
    register: ({ clients }) => {
      if (!clients.wikipedia || !clients.wikipediaSummarizer) {
        return {};
      }
      return {
        functions: {
          query_wikipedia: createWikipediaLookupHandler({
            client: clients.wikipedia,
            summarize: clients.wikipediaSummarizer
          })
        }
      };
    }
  },
  {
    name: "save_memory",
    definition: requiredDefinition("save_memory"),
    register: ({ clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      return {
        functions: {
          save_memory: createSaveMemoryHandler({
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory,
            embedding: clients.embedding
          })
        }
      };
    }
  },
  {
    name: "save_resource",
    definition: requiredDefinition("save_resource"),
    register: ({ clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      const registrations: FunctionModuleRegistrations = {
        functions: {
          save_resource: createSaveResourceHandler({
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
          })
        }
      };
      if (
        clients.catalog &&
        clients.agentJobStore &&
        clients.attachmentScanQueue &&
        clients.attachmentScanWorkStore
      ) {
        registrations.textMessages = {
          upload_intent_activation: createUploadIntentTextMessageHandler({
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
          }),
          pending_attachment_answer: createPendingAttachmentTextMessageHandler({
            sessionStore: clients.sessionStore,
            catalog: clients.catalog,
            agentJobStore: clients.agentJobStore,
            scanQueue: clients.attachmentScanQueue,
            scanWorkStore: clients.attachmentScanWorkStore,
            mediaSyncStore: clients.mediaSyncStore,
            now: clients.now
          })
        };
      }
      return registrations;
    }
  },
  {
    name: "retrieve_memory",
    definition: requiredDefinition("retrieve_memory"),
    register: ({ clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      return {
        functions: {
          retrieve_memory: createRetrieveMemoryHandler({
            memoryStore: clients.memoryStore,
            now: clients.now,
            embedding: clients.embedding,
            textGenerator: clients.knowledgeTextGenerator
          })
        }
      };
    }
  }
];

function requiredDefinition(name: FunctionName): FunctionDefinition {
  const definition = getFunctionDefinition(name);
  if (!definition) throw new Error(`Missing function definition: ${name}`);
  return definition;
}
