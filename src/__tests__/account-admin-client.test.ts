import { describe, expect, it, vi } from "vitest";

import { createAccountAdminClient } from "../account/account-admin-client.js";

const lineUserId = `U${"a".repeat(32)}`;

describe("account admin client", () => {
  it("authorizes through the private Account API with the bot caller identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ bound: true, allowed: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = createAccountAdminClient({
      baseUrl: "http://127.0.0.1:3500/v1.0/invoke/account-api/method",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(client.authorizeAdministrator(lineUserId)).resolves.toEqual({
      bound: true,
      allowed: true
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3500/v1.0/invoke/account-api/method/priv/account/v1/line/authorize",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-internal-caller-app-id": "hhc-line-function-bot"
        }),
        body: JSON.stringify({ line_user_id: lineUserId })
      })
    );
  });

  it("creates a short-lived binding URL without exposing the LINE user id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          binding_url: "https://account.alive.org.tw/line/bind?token=opaque",
          expires_at: "2026-07-28T12:00:00Z"
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    const binding = await client.createBinding(lineUserId, "helper");
    expect(binding).toEqual({
      bindingUrl: "https://account.alive.org.tw/line/bind?token=opaque",
      expiresAt: "2026-07-28T12:00:00Z"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://account-api/priv/account/v1/line/bindings",
      expect.objectContaining({
        body: JSON.stringify({ line_user_id: lineUserId, profile_name: "helper" })
      })
    );
    expect(binding.bindingUrl).not.toContain(lineUserId);
  });

  it("fails closed when Account API is unavailable", async () => {
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    });

    await expect(client.authorizeAdministrator(lineUserId)).rejects.toThrow("account_api_http_503");
  });
});
