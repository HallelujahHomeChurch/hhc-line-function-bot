import { tool } from "langchain";
import { z } from "zod";

import type { FunctionExecutionResult } from "../application/contracts/function-execution.js";
import { getFunctionDefinition } from "../functions/definitions.js";
import type {
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  JsonRecord
} from "../types.js";

interface SdkFunctionToolsOptions {
  context: FunctionHandlerContext;
  functionRegistry: FunctionRegistry;
  authorize?: (functionName: FunctionName) => Promise<boolean>;
  onResult?: (functionName: FunctionName, result: FunctionExecutionResult) => void;
}

export function createSdkFunctionTools(options: SdkFunctionToolsOptions) {
  const { context, functionRegistry } = options;
  if (context.event.source.type === "group" && !context.event.source.userId) return [];

  return context.profile.enabledFunctions.flatMap((functionName) => {
    const definition = getFunctionDefinition(functionName);
    const handler = functionRegistry[functionName];
    if (!definition || !handler || !definition.allowedSources.includes(sourceType(context))) {
      return [];
    }
    if (!(definition.argumentSchema instanceof z.ZodObject)) return [];

    return [
      tool(
        async (args) => {
          if (
            !context.profile.enabledFunctions.includes(functionName) ||
            (options.authorize && !(await options.authorize(functionName)))
          ) {
            return { status: "denied" as const, reason: "authorization_changed" as const };
          }
          const result = await handler(args as JsonRecord, context);
          options.onResult?.(functionName, result);
          return {
            status: result.agentResult?.status ?? (result.ok ? "success" : "error"),
            ...(result.writePhase ? { writePhase: result.writePhase } : {}),
            ...(result.agentResult ? { evidence: result.agentResult } : {})
          };
        },
        {
          name: functionName,
          description: definition.agentCapability?.semanticDescription ?? definition.description,
          schema: definition.argumentSchema.strict()
        }
      )
    ];
  });
}

function sourceType(context: FunctionHandlerContext): "user" | "group" {
  return context.event.source.type === "group" ? "group" : "user";
}
