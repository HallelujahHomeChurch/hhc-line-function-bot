import { MODEL_PROVIDER_LANE_NAMES } from "../types.js";
import type {
  ModelProviderLane,
  ModelProviderName,
  ProviderLanePolicy,
  ProviderPolicy
} from "../types.js";

export type PartialProviderPolicy = Partial<Record<ModelProviderLane, Partial<ProviderLanePolicy>>>;

export function normalizeProviderPolicy(input: {
  profileName: string;
  allowedProviders: ModelProviderName[];
  explicitPolicy?: PartialProviderPolicy;
}): ProviderPolicy {
  const normalized = {} as ProviderPolicy;
  for (const lane of MODEL_PROVIDER_LANE_NAMES) {
    const defaultPolicy = defaultPolicyForLane(lane, input.allowedProviders);
    const explicit = input.explicitPolicy?.[lane];
    if (explicit?.fallback) {
      throw new Error(
        `Profile ${input.profileName} providerPolicy.${lane} fallback is no longer supported`
      );
    }
    const primary = explicit?.primary ?? defaultPolicy.primary;
    assertAllowed(input.profileName, lane, "primary", primary, input.allowedProviders);
    normalized[lane] = { primary };
  }
  return normalized;
}

export function defaultPolicyForLane(
  _lane: ModelProviderLane,
  allowedProviders: ModelProviderName[]
): ProviderLanePolicy {
  if (!allowedProviders.includes("deepseek")) {
    throw new Error("DeepSeek must be listed in allowedProviders");
  }
  return { primary: "deepseek" };
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
