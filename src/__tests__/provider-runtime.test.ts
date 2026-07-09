import { describe, expect, it, vi } from "vitest";

import {
  createProfileAwareProvider,
  resolvePrimaryProviderName,
  resolveProviderNameForLane
} from "../llm/provider-runtime.js";
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
    enabledFunctions: ["query_service_schedule"],
    allowedProviders: ["ollama"],
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
      provider: "ollama",
      fallbackProvider: "ollama",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000,
      timeoutMs: 8000,
      keywordFallbackEnabled: true,
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
  it("selects the global primary provider when no lane is requested", async () => {
    const appConfig = config(
      [
        profile({
          allowedProviders: ["ollama", "deepseek"]
        })
      ],
      { provider: "deepseek" }
    );
    const deepseek = provider("deepseek");
    const ollama = provider("ollama");
    const runtime = createProfileAwareProvider({
      config: appConfig,
      providers: { ollama, deepseek },
      role: "primary"
    });

    await expect(
      runtime.completeJson({
        profileName: "helper",
        prompt: "route",
        text: "hello",
        enabledFunctions: []
      })
    ).resolves.toBe("deepseek");
    expect(deepseek.completeJson).toHaveBeenCalledOnce();
    expect(ollama.completeJson).not.toHaveBeenCalled();
  });

  it("uses local routing lanes while using DeepSeek for smart talk when allowed", async () => {
    const appConfig = config([
      profile({
        allowedProviders: ["ollama", "deepseek"]
      })
    ]);
    const deepseek = provider("deepseek");
    const ollama = provider("ollama");

    expect(resolveProviderNameForLane(appConfig, "helper", "function_routing", "primary")).toBe(
      "ollama"
    );
    expect(resolveProviderNameForLane(appConfig, "helper", "smart_talk", "primary")).toBe(
      "deepseek"
    );
    expect(resolveProviderNameForLane(appConfig, "helper", "smart_talk", "fallback")).toBe(
      "ollama"
    );

    const smartTalkRuntime = createProfileAwareProvider({
      config: appConfig,
      providers: { ollama, deepseek },
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
    expect(ollama.completeText).not.toHaveBeenCalled();

    const routingRuntime = createProfileAwareProvider({
      config: appConfig,
      providers: { ollama, deepseek },
      role: "primary",
      lane: "function_routing"
    });
    await expect(
      routingRuntime.completeJson({
        profileName: "helper",
        prompt: "route",
        text: "查服事表",
        enabledFunctions: ["query_service_schedule"]
      })
    ).resolves.toBe("ollama");
    expect(ollama.completeJson).toHaveBeenCalledOnce();
  });

  it("honors explicit lane provider policy overrides", () => {
    const appConfig = config([
      profile({
        allowedProviders: ["ollama", "deepseek"],
        providerPolicy: {
          smart_talk: { primary: "ollama" },
          general_agent: { primary: "deepseek", fallback: "ollama" }
        }
      })
    ]);

    expect(resolveProviderNameForLane(appConfig, "helper", "smart_talk", "primary")).toBe("ollama");
    expect(resolveProviderNameForLane(appConfig, "helper", "general_agent", "primary")).toBe(
      "deepseek"
    );
    expect(resolveProviderNameForLane(appConfig, "helper", "general_agent", "fallback")).toBe(
      "ollama"
    );
  });

  it("rejects providers outside the profile allowed provider list", () => {
    const appConfig = config(
      [
        profile({
          allowedProviders: ["ollama"],
          allowSubscriptionProviders: false
        })
      ],
      { provider: "deepseek" }
    );

    expect(() => resolvePrimaryProviderName(appConfig, appConfig.profiles[0])).toThrow(
      "Provider deepseek is not allowed for profile helper"
    );
  });
});
