import { tool } from "langchain";
import type { z } from "zod";

import {
  findPopSheetMusicAgentArgumentsSchema,
  findPptSlidesAgentArgumentsSchema,
  findResourceAgentArgumentsSchema,
  queryKnowledgeAgentArgumentsSchema,
  queryScheduleAgentArgumentsSchema,
  queryWikipediaAgentArgumentsSchema,
  retrieveMemoryAgentArgumentsSchema
} from "../function-arguments.js";
import { getFunctionDefinition } from "../functions/definitions.js";
import type { FunctionName, JsonRecord } from "../types.js";
import { createHelperToolGateway, type HelperToolGatewayOptions } from "./policy-gateway.js";
import type { HelperToolSourceType } from "./tool-result.js";

const readToolDefinitions = [
  {
    name: "get_official_schedule",
    capability: "query_schedule",
    sourceType: "official",
    schema: queryScheduleAgentArgumentsSchema
  },
  {
    name: "find_presentation",
    capability: "find_ppt_slides",
    sourceType: "official",
    schema: findPptSlidesAgentArgumentsSchema
  },
  {
    name: "find_sheet_music",
    capability: "find_sheet_music",
    sourceType: "official",
    schema: findPopSheetMusicAgentArgumentsSchema
  },
  {
    name: "find_resource",
    capability: "find_resource",
    sourceType: "official",
    schema: findResourceAgentArgumentsSchema
  },
  {
    name: "search_knowledge",
    capability: "query_knowledge",
    sourceType: "knowledge",
    schema: queryKnowledgeAgentArgumentsSchema
  },
  {
    name: "search_saved_notes",
    capability: "retrieve_memory",
    sourceType: "saved_note",
    schema: retrieveMemoryAgentArgumentsSchema
  },
  {
    name: "query_wikipedia",
    capability: "query_wikipedia",
    sourceType: "public",
    schema: queryWikipediaAgentArgumentsSchema
  }
] as const satisfies readonly {
  name: string;
  capability: FunctionName;
  sourceType: HelperToolSourceType;
  schema: z.ZodObject;
}[];

export function createHelperReadTools(options: HelperToolGatewayOptions) {
  const source = options.context.event.source.type;
  const allowedSource = source === "group" ? "group" : source === "user" ? "user" : undefined;
  if (
    options.context.profile.name !== "helper" ||
    !allowedSource ||
    !options.context.event.source.userId
  ) {
    return [];
  }

  const gateway = createHelperToolGateway(options);
  return readToolDefinitions.flatMap((candidate) => {
    const definition = getFunctionDefinition(candidate.capability);
    if (
      !definition ||
      !options.context.profile.enabledFunctions.includes(candidate.capability) ||
      (options.context.profile.permissionRequiredFunctions.includes(candidate.capability) &&
        !options.authorize) ||
      !options.handlers[candidate.capability] ||
      !definition.allowedSources.includes(allowedSource)
    ) {
      return [];
    }
    return [
      tool(
        (args) => gateway.execute(candidate.capability, args as JsonRecord, candidate.sourceType),
        {
          name: candidate.name,
          description:
            definition.agentCapability?.semanticDescription ?? definition.shortDescription,
          schema: candidate.schema
        }
      )
    ];
  });
}
