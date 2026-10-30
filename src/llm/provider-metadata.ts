import type { ModelProviderName, ProviderCapabilities } from "../types.js";

export const providerCapabilities: Record<ModelProviderName, ProviderCapabilities> = {
  openai: {
    structuredOutput: true,
    smartTalk: true,
    largeContext: true,
    requiresExternalAuth: false,
    subscriptionBased: false,
    remoteApi: true
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
