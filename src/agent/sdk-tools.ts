import { tool } from "langchain";
import { z } from "zod";

import type { FunctionExecutionResult } from "../application/contracts/function-execution.js";
import {
  queryScheduleAgentArgumentsSchema,
  saveMemoryAgentArgumentsSchema,
  saveResourceAgentArgumentsSchema,
  saveScheduleAgentArgumentsSchema
} from "../function-arguments.js";
import { getFunctionDefinition } from "../functions/definitions.js";
import { createSheetMusicResearchTools } from "../helper-agent/sheet-music-tools.js";
import type { PublicPageReader } from "../clients/public-page.js";
import type {
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  JsonRecord,
  WebSearchClient,
  WebSearchResult
} from "../types.js";

interface SdkFunctionToolsOptions {
  context: FunctionHandlerContext;
  functionRegistry: FunctionRegistry;
  authorize?: (functionName: FunctionName) => Promise<boolean>;
  onResult?: (functionName: FunctionName, result: FunctionExecutionResult) => void;
  externalSheetMusicSearch?: {
    allowed: boolean;
    pageReader: PublicPageReader;
    webSearch: WebSearchClient;
    onDirectFileCandidates?: (candidates: WebSearchResult[]) => Promise<void>;
  };
}

const directTools: FunctionName[] = [
  "query_schedule",
  "query_wikipedia",
  "save_schedule",
  "save_memory",
  "save_resource"
];
const informationFunctions: FunctionName[] = ["query_knowledge", "retrieve_memory"];
const modelDataFunctions: FunctionName[] = [...informationFunctions, "query_wikipedia"];
const fileFunctions = {
  presentation: "find_ppt_slides",
  sheet_music: "find_sheet_music",
  resource: "find_resource"
} as const satisfies Record<string, FunctionName>;
const agentArgumentSchemas = {
  query_schedule: queryScheduleAgentArgumentsSchema,
  save_schedule: saveScheduleAgentArgumentsSchema,
  save_memory: saveMemoryAgentArgumentsSchema,
  save_resource: saveResourceAgentArgumentsSchema
} as const;

export function createSdkFunctionTools(options: SdkFunctionToolsOptions) {
  const { context } = options;
  if (context.profile.name !== "helper") return [];
  if (context.event.source.type === "group" && !context.event.source.userId) return [];

  return [
    ...directTools.flatMap((functionName) => createDirectTool(options, functionName)),
    ...createInformationTool(options),
    ...createFileTool(options),
    ...createExternalSheetMusicTools(options)
  ];
}

function createDirectTool(options: SdkFunctionToolsOptions, functionName: FunctionName) {
  const definition = availableDefinition(options, functionName);
  if (!definition || !(definition.argumentSchema instanceof z.ZodObject)) return [];
  const schema =
    functionName in agentArgumentSchemas
      ? agentArgumentSchemas[functionName as keyof typeof agentArgumentSchemas]
      : definition.argumentSchema.strict();
  return [
    tool((args) => executeFunction(options, functionName, args as JsonRecord), {
      name: functionName,
      description: definition.agentCapability?.semanticDescription ?? definition.description,
      schema
    })
  ];
}

function createInformationTool(options: SdkFunctionToolsOptions) {
  const functions = informationFunctions.filter((name) => availableDefinition(options, name));
  if (!functions.length) return [];
  return [
    tool(
      async ({ query }) => ({
        status: "complete",
        results: await Promise.all(
          functions.map(async (capability) => ({
            capability,
            ...(await executeFunction(options, capability, { query }))
          }))
        )
      }),
      {
        name: "search_information",
        description:
          "查詢目前 requester 可見的已加入知識與明確保存筆記；可用來補充正式服事表，並保留來源類型。",
        schema: z.object({ query: z.string().trim().min(1).max(500) }).strict()
      }
    )
  ];
}

function createFileTool(options: SdkFunctionToolsOptions) {
  const availableKinds = Object.entries(fileFunctions).filter(([, functionName]) =>
    availableDefinition(options, functionName)
  );
  if (!availableKinds.length) return [];
  const allowedKinds = availableKinds.map(([kind]) => kind) as [string, ...string[]];
  return [
    tool(
      async ({ query, kind }) => {
        const selected = availableKinds.filter(
          ([candidate]) => kind === "any" || candidate === kind
        );
        return {
          status: "complete",
          results: await Promise.all(
            selected.map(async ([selectedKind, capability]) => ({
              kind: selectedKind,
              capability,
              ...(await executeFunction(options, capability, { query }))
            }))
          )
        };
      },
      {
        name: "search_files",
        description: "搜尋已授權的教會投影片、歌譜或一般資源檔案。",
        schema: z
          .object({
            query: z.string().trim().min(1).max(500),
            kind: z.enum([...allowedKinds, "any"])
          })
          .strict()
      }
    )
  ];
}

function createExternalSheetMusicTools(options: SdkFunctionToolsOptions) {
  const external = options.externalSheetMusicSearch;
  if (!external || !availableDefinition(options, "find_sheet_music")) return [];
  return createSheetMusicResearchTools({
    consented: external.allowed,
    context: options.context,
    pageReader: external.pageReader,
    webSearch: external.webSearch,
    authorize: options.authorize,
    onDirectFileCandidates: external.onDirectFileCandidates
  });
}

async function executeFunction(
  options: SdkFunctionToolsOptions,
  functionName: FunctionName,
  args: JsonRecord
) {
  if (
    !availableDefinition(options, functionName) ||
    (options.authorize && !(await options.authorize(functionName)))
  ) {
    return { status: "denied" as const, reason: "authorization_changed" as const };
  }
  const result = await options.functionRegistry[functionName]!(args, {
    ...options.context,
    agentTool: true
  });
  options.onResult?.(functionName, result);
  return projectResult(result, functionName);
}

function projectResult(result: FunctionExecutionResult, functionName?: FunctionName) {
  const informationResult = functionName && informationFunctions.includes(functionName);
  const modelData = result.agentResult?.replyData ?? result.responseData;
  return {
    status: result.agentResult?.status ?? (result.ok ? "success" : "error"),
    ...(result.writePhase ? { writePhase: result.writePhase } : {}),
    ...(!informationResult && result.agentResult ? { evidence: result.agentResult } : {}),
    ...(functionName && modelDataFunctions.includes(functionName) && modelData
      ? { data: modelData }
      : {})
  };
}

function availableDefinition(options: SdkFunctionToolsOptions, functionName: FunctionName) {
  if (!options.context.profile.enabledFunctions.includes(functionName)) return undefined;
  if (!options.functionRegistry[functionName]) return undefined;
  const definition = getFunctionDefinition(functionName);
  return definition?.allowedSources.includes(sourceType(options.context)) ? definition : undefined;
}

function sourceType(context: FunctionHandlerContext): "user" | "group" {
  return context.event.source.type === "group" ? "group" : "user";
}
