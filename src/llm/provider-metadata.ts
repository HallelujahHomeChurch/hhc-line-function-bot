import type { ModelProviderName, ProviderCapabilities } from "../types.js";

export const providerCapabilities: Record<ModelProviderName, ProviderCapabilities> = {
  ollama: {
    structuredOutput: true,
    smartTalk: true,
    largeContext: false,
    requiresExternalAuth: false,
    subscriptionBased: false,
    remoteApi: false
  },
  deepseek: {
    structuredOutput: true,
    smartTalk: true,
    largeContext: true,
    requiresExternalAuth: false,
    subscriptionBased: false,
    remoteApi: true
  }
};
