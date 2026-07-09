import { MODEL_PROVIDER_LANE_NAMES } from "../types.js";
import type {
  ModelProviderLane,
  ModelProviderName,
  ProviderLanePolicy,
  ProviderPolicy
} from "../types.js";

export type PartialProviderPolicy = Partial<Record<ModelProviderLane, Partial<ProviderLanePolicy>>>;

const LOCAL_FIRST_LANES = new Set<ModelProviderLane>([
  "function_routing",
  "admin_routing",
  "memory_routing"
]);

const REMOTE_FIRST_LANES = new Set<ModelProviderLane>([
  "smart_talk",
  "general_agent",
  "context_compression"
]);

export function normalizeProviderPolicy(input: {
  profileName: string;
  allowedProviders: ModelProviderName[];
  explicitPolicy?: PartialProviderPolicy;
}): ProviderPolicy {
  const normalized = {} as ProviderPolicy;
  for (const lane of MODEL_PROVIDER_LANE_NAMES) {
    const defaultPolicy = defaultPolicyForLane(lane, input.allowedProviders);
    const explicit = input.explicitPolicy?.[lane];
    const primary = explicit?.primary ?? defaultPolicy.primary;
    const fallback = explicit?.fallback ?? defaultPolicy.fallback;
    assertAllowed(input.profileName, lane, "primary", primary, input.allowedProviders);
    if (fallback) {
      assertAllowed(input.profileName, lane, "fallback", fallback, input.allowedProviders);
    }
    normalized[lane] = fallback ? { primary, fallback } : { primary };
  }
  return normalized;
}

export function defaultPolicyForLane(
  lane: ModelProviderLane,
  allowedProviders: ModelProviderName[]
): ProviderLanePolicy {
  const local = preferredLocalProvider(allowedProviders);
  if (REMOTE_FIRST_LANES.has(lane)) {
    const primary = allowedProviders.includes("deepseek") ? "deepseek" : local;
    if (primary !== local && lane !== "context_compression") {
      return { primary, fallback: local };
    }
    return { primary };
  }
  if (LOCAL_FIRST_LANES.has(lane)) {
    return { primary: local };
  }
  return { primary: local };
}

function preferredLocalProvider(allowedProviders: ModelProviderName[]): ModelProviderName {
  return allowedProviders.includes("ollama") ? "ollama" : (allowedProviders[0] ?? "ollama");
}

function assertAllowed(
  profileName: string,
  lane: ModelProviderLane,
  role: "primary" | "fallback",
  provider: ModelProviderName,
  allowedProviders: ModelProviderName[]
): void {
  if (!allowedProviders.includes(provider)) {
    throw new Error(
      `Profile ${profileName} providerPolicy.${lane} ${role} provider ${provider} is not allowed`
    );
  }
}
