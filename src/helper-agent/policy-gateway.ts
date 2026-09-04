import type { CapabilityName } from "../capabilities/names.js";
import { getFunctionDefinition } from "../capabilities/catalog.js";
import { takeToolCall } from "./budget.js";
import {
  projectToolResult,
  type HelperToolResult,
  type HelperToolSourceType
} from "./tool-result.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionRegistry,
  JsonRecord
} from "../types.js";

export interface HelperToolGatewayOptions {
  context: FunctionHandlerContext;
  handlers: FunctionRegistry;
  authorize?: (name: CapabilityName) => Promise<boolean>;
  onDomainResult?: (
    name: CapabilityName,
    args: JsonRecord,
    result: FunctionExecutionResult,
    invocationOrder: number
  ) => void;
}

export function createHelperToolGateway(options: HelperToolGatewayOptions) {
  let nextInvocationOrder = 0;
  return {
    async execute(
      name: CapabilityName,
      args: JsonRecord,
      sourceType: HelperToolSourceType
    ): Promise<HelperToolResult> {
      takeToolCall();
      const invocationOrder = ++nextInvocationOrder;
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
      const requiresAccount =
        definition.sideEffectLevel !== "read" ||
        options.context.profile.permissionRequiredFunctions.includes(name);
      if (requiresAccount && !options.authorize) return denied(sourceType);
      if (options.authorize) {
        try {
          if (!(await options.authorize(name))) return denied(sourceType);
        } catch {
          return unavailable(sourceType);
        }
      }
      const handler = options.handlers[name];
      if (!handler) return unavailable(sourceType);
      let result: FunctionExecutionResult;
      try {
        result = await handler(parsedArgs, { ...options.context, agentTool: true });
      } catch {
        return unavailable(sourceType);
      }
      options.onDomainResult?.(name, parsedArgs, result, invocationOrder);
      return projectToolResult(result, sourceType);
    }
  };
}

function denied(sourceType: HelperToolSourceType): HelperToolResult {
  return { status: "denied", sourceType };
}

function unavailable(sourceType: HelperToolSourceType): HelperToolResult {
  return { status: "unavailable", sourceType };
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
