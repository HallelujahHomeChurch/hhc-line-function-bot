import { z } from "zod";

import { getNaturalLanguageAdminActions } from "./actions/catalog.js";
import { coerceFunctionArguments, ProviderResponseError } from "./router.js";
import { isAdminActionName } from "./types.js";
import type {
  AdminActionRouteInput,
  AdminActionRouteResult,
  AdminActionRouterPort,
  ChatProvider
} from "./types.js";

const modelDecisionSchema = z.object({
  action: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
  arguments: z.unknown().optional()
});

export interface AdminActionRouterOptions {
  primary: ChatProvider;
}

export function createAdminActionRouter(options: AdminActionRouterOptions): AdminActionRouterPort {
  return new AdminActionRouter(options);
}

class AdminActionRouter implements AdminActionRouterPort {
  constructor(private readonly options: AdminActionRouterOptions) {}

  async route(input: AdminActionRouteInput): Promise<AdminActionRouteResult> {
    const prompt = buildAdminRouterPrompt(input.enabledActions);
    try {
      return parseProviderDecision(
        await this.options.primary.completeJson({ ...input, enabledFunctions: [], prompt }),
        input
      );
    } catch (error) {
      return {
        type: "deny",
        reason: providerErrorReason(error),
        provider: "router",
        fallbackProvider: "ollama"
      };
    }
  }
}

function parseProviderDecision(
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
      provider: "ollama"
    };
  }

  if (!isAdminActionName(action)) {
    return { type: "deny", reason: "unknown_action", provider: "ollama" };
  }

  if (!input.enabledActions.includes(action)) {
    return { type: "deny", reason: "admin_action_disabled", provider: "ollama" };
  }

  return {
    type: "execute",
    action,
    arguments: coerceFunctionArguments(parsed.data.arguments),
    confidence: parsed.data.confidence,
    provider: "ollama"
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
    "Available admin actions:",
    available || "(none)"
  ].join("\n");
}
