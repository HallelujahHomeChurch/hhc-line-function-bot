import { describe, expect, it, vi } from "vitest";

import { createAdminActionRouter } from "../admin-action-router.js";
import { ProviderResponseError } from "../llm/provider-response.js";
import type { ChatProvider } from "../types.js";

function provider(raw: string): ChatProvider {
  return {
    completeJson: vi.fn().mockResolvedValue(raw)
  };
}

describe("admin action router", () => {
  it("routes invite-code requests to invite_code_create", async () => {
    const deepseek = provider(
      JSON.stringify({
        action: "invite_code_create",
        confidence: 0.94,
        arguments: {}
      })
    );
    const router = createAdminActionRouter({ primary: deepseek });

    const result = await router.route({
      profileName: "helper",
      text: "please create an invite code",
      enabledActions: ["invite_code_create"],
      source: { type: "user", userId: "Uroot" }
    });

    expect(result).toEqual({
      type: "execute",
      action: "invite_code_create",
      arguments: {},
      confidence: 0.94,
      provider: "deepseek"
    });
  });

  it("denies unknown admin actions", async () => {
    const router = createAdminActionRouter({
      primary: provider(JSON.stringify({ action: "access_delete_everything" }))
    });

    await expect(
      router.route({
        profileName: "helper",
        text: "delete all access",
        enabledActions: ["invite_code_create"],
        source: { type: "user", userId: "Uroot" }
      })
    ).resolves.toMatchObject({
      type: "deny",
      reason: "unknown_action"
    });
  });

  it("denies invalid provider responses without fallback execution", async () => {
    const router = createAdminActionRouter({ primary: provider("not json") });

    await expect(
      router.route({
        profileName: "helper",
        text: "please create an invite code",
        enabledActions: ["invite_code_create"],
        source: { type: "user", userId: "Uroot" }
      })
    ).resolves.toMatchObject({
      type: "deny",
      reason: "invalid_json",
      provider: "router",
      fallbackProvider: "deepseek"
    });
  });

  it("does not retry the same provider as an admin action fallback", async () => {
    const primary: ChatProvider = {
      providerName: "deepseek",
      completeJson: vi.fn().mockRejectedValue(new ProviderResponseError("invalid_json"))
    };
    const modelFallback: ChatProvider = {
      providerName: "deepseek",
      completeJson: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ action: "invite_code_create", arguments: {} }))
    };
    const router = createAdminActionRouter({ primary, modelFallback });

    const result = await router.route({
      profileName: "helper",
      text: "please create an invite code",
      enabledActions: ["invite_code_create"],
      source: { type: "user", userId: "Uroot" }
    });

    expect(result).toMatchObject({
      type: "deny",
      reason: "invalid_json",
      provider: "router",
      fallbackProvider: "deepseek"
    });
    expect(modelFallback.completeJson).not.toHaveBeenCalled();
  });
});
