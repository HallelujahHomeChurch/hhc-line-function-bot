import { getFunctionDefinition } from "../functions/definitions.js";
import { takeToolCall } from "./budget.js";
import {
  projectToolResult,
  type HelperToolResult,
  type HelperToolSourceType
} from "./tool-result.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  JsonRecord
} from "../types.js";

export interface HelperToolGatewayOptions {
  context: FunctionHandlerContext;
  handlers: FunctionRegistry;
  authorize?: (name: FunctionName) => Promise<boolean>;
  onDomainResult?: (name: FunctionName, result: FunctionExecutionResult) => void;
}

export function createHelperToolGateway(options: HelperToolGatewayOptions) {
  return {
    async execute(
      name: FunctionName,
      args: JsonRecord,
      sourceType: HelperToolSourceType = "official"
    ): Promise<HelperToolResult> {
      takeToolCall();
      const definition = getFunctionDefinition(name);
      const parsedArgs = definition
        ? validatedArguments(definition.argumentSchema, args)
        : undefined;
      if (
        !definition ||
        !options.context.profile.enabledFunctions.includes(name) ||
        !allowedSource(options.context, definition.allowedSources) ||
        !parsedArgs ||
        (definition.sideEffectLevel !== "read" && hasModelReviewArgument(args))
      ) {
        return denied(sourceType);
      }
      if (!options.authorize && definition.sideEffectLevel !== "read") return denied(sourceType);
      if (options.authorize && !(await options.authorize(name))) return denied(sourceType);
      const handler = options.handlers[name];
      if (!handler) return { status: "unavailable", sourceType };
      const result = await handler(parsedArgs, {
        ...options.context,
        agentTool: true
      });
      options.onDomainResult?.(name, result);
      return projectToolResult(result, sourceType);
    }
  };
}

function denied(sourceType: HelperToolSourceType): HelperToolResult {
  return { status: "denied", sourceType };
}

function allowedSource(
  context: FunctionHandlerContext,
  allowedSources: readonly ("user" | "group")[]
): boolean {
  const source = context.event.source.type === "group" ? "group" : context.event.source.type;
  return (source === "user" || source === "group") && allowedSources.includes(source);
}

function validatedArguments(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  args: JsonRecord
): JsonRecord | undefined {
  const parsed = schema.safeParse(args);
  return parsed.success && isStrictSubset(args, parsed.data)
    ? (parsed.data as JsonRecord)
    : undefined;
}

function isStrictSubset(args: JsonRecord, parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  return Object.entries(args).every(([key, value]) => {
    if (!Object.hasOwn(parsed as object, key)) return false;
    return isStrictValue(value, (parsed as JsonRecord)[key]);
  });
}

function isStrictValue(value: unknown, parsed: unknown): boolean {
  if (Array.isArray(value)) {
    return (
      Array.isArray(parsed) &&
      value.length === parsed.length &&
      value.every((item, index) => isStrictValue(item, parsed[index]))
    );
  }
  if (!value || typeof value !== "object") return true;
  return isStrictSubset(value as JsonRecord, parsed);
}

function hasModelReviewArgument(args: JsonRecord): boolean {
  return "confirm" in args || "cancel" in args;
}
