import { z } from "zod";

import { parseFunctionArguments } from "./function-arguments.js";
import { normalizeFunctionArguments } from "./functions/argument-normalization.js";
import { getFunctionDefinitions } from "./functions/definitions.js";
import { FUNCTION_NAMES, isFunctionName, isSystemActionName } from "./types.js";
import type {
  ChatProvider,
  FunctionName,
  FunctionRouterPort,
  JsonRecord,
  ModelProviderLane,
  ModelProviderName,
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
  modelFallback?: ChatProvider;
  keywordFallback?: KeywordFallbackRouter;
  keywordFallbackEnabled: boolean;
  lane?: ModelProviderLane;
}

export function createFunctionRouter(options: FunctionRouterOptions): FunctionRouterPort {
  return new FunctionRouter(options);
}

class FunctionRouter implements FunctionRouterPort {
  constructor(private readonly options: FunctionRouterOptions) {}

  async route(input: RouteInput): Promise<RouteResult> {
    const prompt = buildRouterPrompt(input.enabledFunctions, input.runtimeContext);
    let fallbackReason: string | undefined;
    let keywordFallbackProvider = this.primaryProviderName(input.profileName);

    try {
      return this.withLane(
        parseProviderDecision(
          this.primaryProviderName(input.profileName),
          await this.options.primary.completeJson({ ...input, prompt }),
          input
        )
      );
    } catch (error) {
      fallbackReason = providerErrorReason(error);
      if (this.shouldFallback(error) && this.options.modelFallback) {
        const modelFallbackProvider = this.modelFallbackProviderName(input.profileName);
        if (modelFallbackProvider !== this.primaryProviderName(input.profileName)) {
          try {
            return this.withLane(
              withFallbackDiagnostics(
                parseProviderDecision(
                  modelFallbackProvider,
                  await this.options.modelFallback.completeJson({ ...input, prompt }),
                  input
                ),
                this.primaryProviderName(input.profileName),
                fallbackReason
              )
            );
          } catch (fallbackError) {
            fallbackReason = providerErrorReason(fallbackError);
            keywordFallbackProvider = modelFallbackProvider;
          }
        }
      }
      if (!this.shouldFallback(error)) {
        return this.withLane({
          type: "deny",
          reason: "router_failed",
          provider: "router",
          fallbackProvider: this.primaryProviderName(input.profileName),
          fallbackReason
        });
      }
    }

    if (!this.options.keywordFallback || !this.options.keywordFallbackEnabled) {
      return this.withLane({
        type: "deny",
        reason: "keyword_fallback_not_configured",
        provider: "router",
        fallbackProvider: this.primaryProviderName(input.profileName),
        fallbackReason
      });
    }

    return this.withLane(
      withFallbackDiagnostics(
        this.options.keywordFallback.route(input),
        keywordFallbackProvider,
        fallbackReason
      )
    );
  }

  private shouldFallback(error: unknown): boolean {
    if (!this.options.keywordFallbackEnabled || !this.options.keywordFallback) {
      return false;
    }
    return error instanceof ProviderResponseError;
  }

  private primaryProviderName(profileName?: string): ModelProviderName {
    if (profileName && this.options.primary.providerNameForProfile) {
      return this.options.primary.providerNameForProfile(profileName);
    }
    return this.options.primary.providerName ?? "ollama";
  }

  private modelFallbackProviderName(profileName?: string): ModelProviderName {
    if (profileName && this.options.modelFallback?.providerNameForProfile) {
      return this.options.modelFallback.providerNameForProfile(profileName);
    }
    return this.options.modelFallback?.providerName ?? "ollama";
  }

  private withLane(result: RouteResult): RouteResult {
    if (!this.options.lane) {
      return result;
    }
    return { ...result, lane: this.options.lane };
  }
}

function withFallbackDiagnostics(
  result: RouteResult,
  fallbackProvider: ModelProviderName,
  fallbackReason: string | undefined
): RouteResult {
  if (!fallbackReason) {
    return result;
  }
  return {
    ...result,
    fallbackProvider,
    fallbackReason
  };
}

function providerErrorReason(error: unknown): string {
  if (error instanceof ProviderResponseError) {
    return error.message || "provider_response_error";
  }
  if (error instanceof Error) {
    return error.name || "error";
  }
  return typeof error;
}

function parseProviderDecision(
  provider: ModelProviderName,
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

  if (isSystemActionName(action)) {
    return {
      type: "respond",
      action,
      arguments: coerceFunctionArguments(parsed.data.arguments),
      confidence: parsed.data.confidence,
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
  const normalizedArguments = normalizeFunctionArguments(action, parsedArguments, {
    text: input.text
  });

  return {
    type: "execute",
    action,
    arguments: normalizedArguments,
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

function buildRouterPrompt(enabledFunctions: FunctionName[], runtimeContext?: string): string {
  const available = getFunctionDefinitions(enabledFunctions)
    .map((definition) => definition.description)
    .join("\n");
  return [
    "You are a strict JSON function router for a LINE bot.",
    "Return exactly one JSON object and no markdown.",
    'If the user request does not clearly match an enabled function, return {"action":"deny","reason":"not_matched"}.',
    'If the user only calls the bot or asks who the bot is, return {"action":"introduce_bot","arguments":{"variant":"identity"}}.',
    'If the user asks what the bot can do or asks for help/usage, return {"action":"introduce_bot","arguments":{"variant":"capabilities"}}.',
    'If the user only greets the bot, return {"action":"small_talk","arguments":{"category":"greeting"}}.',
    'If the user directly asks the bot light chat, wellbeing/check-in, encouragement, persona, thanks, or reassurance, return {"action":"small_talk","arguments":{"category":"greeting|wellbeing|thanks|encouragement|reassurance|persona|light_joke"}}.',
    'If the message only mentions the bot in third person, return {"action":"deny","reason":"not_addressed_to_bot"}.',
    "If the user both greets and requests an enabled function, choose the function instead of introduce_bot.",
    "Never invent a function name.",
    "System actions:",
    "- introduce_bot: controlled introduction/help response. Do not write the final reply text.",
    "- small_talk: controlled short chat response. Do not write the final reply text.",
    "Available functions:",
    available || "(none)",
    runtimeContext ? ["", "Runtime context:", runtimeContext].join("\n") : undefined
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export function coerceFunctionArguments(args: unknown): JsonRecord {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as JsonRecord;
  }
  return {};
}

export { FUNCTION_NAMES };
