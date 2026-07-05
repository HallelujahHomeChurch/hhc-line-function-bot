import { z } from "zod";

import { parseFunctionArguments } from "./function-arguments.js";
import { getFunctionDefinitions } from "./functions/definitions.js";
import { FUNCTION_NAMES, isFunctionName } from "./types.js";
import type {
  ChatProvider,
  FunctionName,
  FunctionRouterPort,
  JsonRecord,
  RouteInput,
  RouteResult
} from "./types.js";
import type { KeywordFallbackRouter } from "./keyword-router.js";

const modelDecisionSchema = z.object({
  action: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
  arguments: z.unknown().optional()
});

export class ProviderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderResponseError";
  }
}

export interface FunctionRouterOptions {
  primary: ChatProvider;
  keywordFallback?: KeywordFallbackRouter;
  keywordFallbackEnabled: boolean;
}

export function createFunctionRouter(options: FunctionRouterOptions): FunctionRouterPort {
  return new FunctionRouter(options);
}

class FunctionRouter implements FunctionRouterPort {
  constructor(private readonly options: FunctionRouterOptions) {}

  async route(input: RouteInput): Promise<RouteResult> {
    const prompt = buildRouterPrompt(input.enabledFunctions);

    try {
      return parseProviderDecision(
        "ollama",
        await this.options.primary.completeJson({ ...input, prompt }),
        input
      );
    } catch (error) {
      if (!this.shouldFallback(error)) {
        return { type: "deny", reason: "router_failed", provider: "router" };
      }
    }

    if (!this.options.keywordFallback || !this.options.keywordFallbackEnabled) {
      return { type: "deny", reason: "keyword_fallback_not_configured", provider: "router" };
    }

    return this.options.keywordFallback.route(input);
  }

  private shouldFallback(error: unknown): boolean {
    if (!this.options.keywordFallbackEnabled || !this.options.keywordFallback) {
      return false;
    }
    return error instanceof ProviderResponseError;
  }
}

function parseProviderDecision(
  provider: "ollama",
  rawContent: string,
  input: RouteInput
): RouteResult {
  const json = parseJsonObject(rawContent);
  const parsed = modelDecisionSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProviderResponseError("invalid_json");
  }

  const action = parsed.data.action.trim();
  if (action === "deny") {
    return {
      type: "deny",
      reason: parsed.data.reason?.trim() || "not_matched",
      provider
    };
  }

  if (!isFunctionName(action)) {
    return { type: "deny", reason: "unknown_action", provider };
  }

  if (!input.enabledFunctions.includes(action)) {
    return { type: "deny", reason: "function_disabled", provider };
  }

  const parsedArguments = parseFunctionArguments(action, parsed.data.arguments);
  if (!parsedArguments) {
    return { type: "deny", reason: "invalid_arguments", provider };
  }
  const argumentsWithFallbacks = applyArgumentFallbacks(action, parsedArguments, input);

  return {
    type: "execute",
    action,
    arguments: argumentsWithFallbacks,
    confidence: parsed.data.confidence,
    provider
  };
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch {
        throw new ProviderResponseError("invalid_json");
      }
    }
    throw new ProviderResponseError("invalid_json");
  }
}

function buildRouterPrompt(enabledFunctions: FunctionName[]): string {
  const available = getFunctionDefinitions(enabledFunctions)
    .map((definition) => definition.description)
    .join("\n");
  return [
    "You are a strict JSON function router for a LINE bot.",
    "Return exactly one JSON object and no markdown.",
    'If the user request does not clearly match an enabled function, return {"action":"deny","reason":"not_matched"}.',
    "Never invent a function name.",
    "Available functions:",
    available || "(none)"
  ].join("\n");
}

export function coerceFunctionArguments(args: unknown): JsonRecord {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as JsonRecord;
  }
  return {};
}

function applyArgumentFallbacks(
  action: FunctionName,
  args: JsonRecord,
  input: RouteInput
): JsonRecord {
  if (action !== "query_service_schedule") {
    return args;
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  const hasStructuredMetadata = [
    args.date,
    args.dateIntent,
    args.specificDate,
    args.meeting,
    args.role
  ].some((value) => typeof value === "string" && value.trim());

  if (query || hasStructuredMetadata) {
    return args;
  }

  return { ...args, query: input.text };
}

export { FUNCTION_NAMES };
