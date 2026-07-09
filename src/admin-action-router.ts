import { z } from "zod";

import { getNaturalLanguageAdminActions } from "./actions/catalog.js";
import { coerceFunctionArguments, ProviderResponseError } from "./router.js";
import { isAdminActionName } from "./types.js";
import type {
  AdminActionRouteInput,
  AdminActionRouteResult,
  AdminActionRouterPort,
  ChatProvider,
  ModelProviderLane,
  ModelProviderName
} from "./types.js";

const modelDecisionSchema = z.object({
  action: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
  arguments: z.unknown().optional()
});

export interface AdminActionRouterOptions {
  primary: ChatProvider;
  modelFallback?: ChatProvider;
  lane?: ModelProviderLane;
}

export function createAdminActionRouter(options: AdminActionRouterOptions): AdminActionRouterPort {
  return new AdminActionRouter(options);
}

class AdminActionRouter implements AdminActionRouterPort {
  constructor(private readonly options: AdminActionRouterOptions) {}

  async route(input: AdminActionRouteInput): Promise<AdminActionRouteResult> {
    const prompt = buildAdminRouterPrompt(input.enabledActions);
    try {
      return this.withLane(
        parseProviderDecision(
          this.primaryProviderName(input.profileName),
          await this.options.primary.completeJson({ ...input, enabledFunctions: [], prompt }),
          input
        )
      );
    } catch (error) {
      if (error instanceof ProviderResponseError && this.options.modelFallback) {
        const modelFallbackProvider = this.modelFallbackProviderName(input.profileName);
        if (modelFallbackProvider !== this.primaryProviderName(input.profileName)) {
          try {
            const result = parseProviderDecision(
              modelFallbackProvider,
              await this.options.modelFallback.completeJson({
                ...input,
                enabledFunctions: [],
                prompt
              }),
              input
            );
            return this.withLane({
              ...result,
              fallbackProvider: this.primaryProviderName(input.profileName),
              fallbackReason: providerErrorReason(error)
            });
          } catch (fallbackError) {
            return this.withLane({
              type: "deny",
              reason: providerErrorReason(fallbackError),
              provider: "router",
              fallbackProvider: modelFallbackProvider
            });
          }
        }
      }
      return this.withLane({
        type: "deny",
        reason: providerErrorReason(error),
        provider: "router",
        fallbackProvider: this.primaryProviderName(input.profileName)
      });
    }
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

  private withLane(result: AdminActionRouteResult): AdminActionRouteResult {
    if (!this.options.lane) {
      return result;
    }
    return { ...result, lane: this.options.lane };
  }
}

function parseProviderDecision(
  provider: ModelProviderName,
  rawContent: string,
  input: AdminActionRouteInput
): AdminActionRouteResult {
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

  if (!isAdminActionName(action)) {
    return { type: "deny", reason: "unknown_action", provider };
  }

  if (!input.enabledActions.includes(action)) {
    return { type: "deny", reason: "admin_action_disabled", provider };
  }

  return {
    type: "execute",
    action,
    arguments: coerceFunctionArguments(parsed.data.arguments),
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

function providerErrorReason(error: unknown): string {
  if (error instanceof ProviderResponseError) {
    return error.message || "provider_response_error";
  }
  if (error instanceof Error) {
    return error.name || "error";
  }
  return typeof error;
}

function buildAdminRouterPrompt(enabledActions: string[]): string {
  const available = getNaturalLanguageAdminActions()
    .filter((definition) => enabledActions.includes(definition.name))
    .map((definition) => `- ${definition.name}: ${definition.description}`)
    .join("\n");
  return [
    "You are a strict JSON admin action router for a LINE bot.",
    "Return exactly one JSON object and no markdown.",
    'If the admin request does not clearly match an enabled admin action, return {"action":"deny","reason":"not_matched"}.',
    "Never invent an action name.",
    "When executing an action, include an arguments object with only fields explicitly present or safely inferred from the user text.",
    "Known argument fields:",
    "- web_allowlist_add: url or domain, optional pathPrefix, optional label.",
    "- function_scope_grant/function_scope_revoke: functionName, optional groupId. If the source is a group and the user says this group/current group, omit groupId.",
    "- function_scope_list: optional groupId. If the source is a group and the user asks about this group/current group, omit groupId.",
    "Available admin actions:",
    available || "(none)"
  ].join("\n");
}
