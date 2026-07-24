import { describe, expect, it, vi } from "vitest";

import {
  createProfileAwareProvider,
  resolvePrimaryProviderName,
  resolveProviderNameForLane
} from "../llm/provider-runtime.js";
import { providerCapabilities } from "../llm/provider-metadata.js";
import { MODEL_PROVIDER_NAMES } from "../types.js";
import type {
  AppConfig,
  BotProfileConfig,
  ChatProvider,
  TextGenerationProvider
} from "../types.js";

function profile(overrides: Partial<BotProfileConfig> = {}): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["query_schedule"],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    ...overrides
  };
}

function config(
  profiles: BotProfileConfig[],
  llmOverrides: Partial<AppConfig["llm"]> = {}
): AppConfig {
  return {
    serviceName: "hhc-line-function-bot",
    host: "127.0.0.1",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    maxBodyBytes: 32_768,
    profiles,
    llm: {
      provider: "deepseek",
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000,

      ...llmOverrides
    }
  };
}

function provider(raw: string): ChatProvider & TextGenerationProvider {
  return {
    completeJson: vi.fn().mockResolvedValue(raw),
    completeText: vi.fn().mockResolvedValue(raw)
  };
}

describe("provider runtime", () => {
  it("exposes DeepSeek as the only model provider", () => {
    expect(MODEL_PROVIDER_NAMES).toEqual(["deepseek"]);
    expect(Object.keys(providerCapabilities)).toEqual(["deepseek"]);
  });

  it("selects DeepSeek as the global primary provider when no lane is requested", async () => {
    const appConfig = config([profile()]);
    const deepseek = provider("deepseek");
    const runtime = createProfileAwareProvider({
      config: appConfig,
      providers: { deepseek },
      role: "primary"
    });
    const controller = new AbortController();

    await expect(
      runtime.completeJson({
        profileName: "helper",
        prompt: "route",
        text: "hello",
        enabledFunctions: [],
        signal: controller.signal
      })
    ).resolves.toBe("deepseek");
    expect(deepseek.completeJson).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("uses DeepSeek for every configured lane without a fallback provider", async () => {
    const appConfig = config([profile()]);
    const deepseek = provider("deepseek");

    expect(resolveProviderNameForLane(appConfig, "helper", "function_routing", "primary")).toBe(
      "deepseek"
    );
    expect(resolveProviderNameForLane(appConfig, "helper", "smart_talk", "primary")).toBe(
      "deepseek"
    );
    expect(resolveProviderNameForLane(appConfig, "helper", "smart_talk", "fallback")).toBe(
      "deepseek"
    );

    const smartTalkRuntime = createProfileAwareProvider({
      config: appConfig,
      providers: { deepseek },
      role: "primary",
      lane: "smart_talk"
    });
    await expect(
      smartTalkRuntime.completeText({
        profileName: "helper",
        prompt: "talk",
        text: "hello",
        category: "greeting",
        maxChars: 80
      })
    ).resolves.toBe("deepseek");
    expect(deepseek.completeText).toHaveBeenCalledOnce();
  });

  it("resolves an omitted fallback role to the DeepSeek primary provider", () => {
    const appConfig = config([profile()]);

    expect(resolveProviderNameForLane(appConfig, "helper", "general_agent", "fallback")).toBe(
      "deepseek"
    );
  });

  it("fails only when the configured primary provider client is absent", async () => {
    const appConfig = config([profile()]);
    const runtime = createProfileAwareProvider({
      config: appConfig,
      providers: {},
      role: "primary",
      lane: "function_routing"
    });

    await expect(
      runtime.completeJson({
        profileName: "helper",
        prompt: "route",
        text: "hello",
        enabledFunctions: []
      })
    ).rejects.toThrow("provider_not_configured:deepseek");
    expect(resolvePrimaryProviderName(appConfig, appConfig.profiles[0])).toBe("deepseek");
  });
});
