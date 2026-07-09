import { ProviderResponseError } from "../router.js";
import { providerCapabilities } from "./provider-metadata.js";
import type {
  AppConfig,
  BotProfileConfig,
  ChatProvider,
  ModelProviderLane,
  ModelProviderName,
  TextGenerationProvider
} from "../types.js";
import { defaultPolicyForLane } from "./provider-policy.js";

export type ProviderRegistry = Record<ModelProviderName, ChatProvider & TextGenerationProvider>;

export function providerIsAllowedForProfile(
  profile: Pick<BotProfileConfig, "allowedProviders" | "allowSubscriptionProviders">,
  provider: ModelProviderName
): boolean {
  if (!profile.allowedProviders.includes(provider)) {
    return false;
  }
  const capabilities = providerCapabilities[provider];
  return !capabilities.subscriptionBased || profile.allowSubscriptionProviders;
}

export function allowedProvidersForProfile(profile: BotProfileConfig): ModelProviderName[] {
  return profile.allowedProviders.filter((provider) =>
    providerIsAllowedForProfile(profile, provider)
  );
}

export function assertProviderAllowedForProfile(
  profile: BotProfileConfig,
  provider: ModelProviderName
): void {
  if (!providerIsAllowedForProfile(profile, provider)) {
    throw new Error(`Provider ${provider} is not allowed for profile ${profile.name}`);
  }
}

export function resolvePrimaryProviderName(
  config: AppConfig,
  profile: BotProfileConfig
): ModelProviderName {
  const provider = profile.llmProvider ?? config.llm.provider ?? "ollama";
  assertProviderAllowedForProfile(profile, provider);
  return provider;
}

export function resolveFallbackProviderName(
  config: AppConfig,
  profile: BotProfileConfig
): ModelProviderName {
  const provider = config.llm.fallbackProvider ?? "ollama";
  assertProviderAllowedForProfile(profile, provider);
  return provider;
}

export function createProfileAwareProvider(options: {
  config: AppConfig;
  providers: ProviderRegistry;
  role: "primary" | "fallback";
  lane?: ModelProviderLane;
}): ChatProvider & TextGenerationProvider {
  return {
    providerNameForProfile: (profileName) =>
      resolveProviderNameForProfile(options.config, profileName, options.role, options.lane),
    async completeJson(request) {
      const provider = resolveProvider(options, request.profileName);
      return provider.completeJson(request);
    },
    async completeText(request) {
      const provider = resolveProvider(options, request.profileName);
      return provider.completeText(request);
    }
  };
}

function resolveProvider(
  options: {
    config: AppConfig;
    providers: ProviderRegistry;
    role: "primary" | "fallback";
    lane?: ModelProviderLane;
  },
  profileName: string
): ChatProvider & TextGenerationProvider {
  const providerName = resolveProviderNameForProfile(
    options.config,
    profileName,
    options.role,
    options.lane
  );
  const provider = options.providers[providerName];
  if (!provider) {
    throw new ProviderResponseError(`provider_not_configured:${providerName}`);
  }
  return provider;
}

function resolveProviderNameForProfile(
  config: AppConfig,
  profileName: string,
  role: "primary" | "fallback",
  lane?: ModelProviderLane
): ModelProviderName {
  if (lane) {
    return resolveProviderNameForLane(config, profileName, lane, role);
  }
  const profile = config.profiles.find((candidate) => candidate.name === profileName);
  if (!profile) {
    throw new ProviderResponseError(`profile_not_found:${profileName}`);
  }
  return role === "primary"
    ? resolvePrimaryProviderName(config, profile)
    : resolveFallbackProviderName(config, profile);
}

export function resolveProviderNameForLane(
  config: AppConfig,
  profileName: string,
  lane: ModelProviderLane,
  role: "primary" | "fallback"
): ModelProviderName {
  const profile = config.profiles.find((candidate) => candidate.name === profileName);
  if (!profile) {
    throw new ProviderResponseError(`profile_not_found:${profileName}`);
  }
  const policy =
    profile.providerPolicy?.[lane] ?? defaultPolicyForLane(lane, profile.allowedProviders);
  const provider = role === "primary" ? policy.primary : (policy.fallback ?? policy.primary);
  assertProviderAllowedForProfile(profile, provider);
  return provider;
}
