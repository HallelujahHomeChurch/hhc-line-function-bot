import { describe, expect, it, vi } from "vitest";

import { createAccountAdminClient } from "../account/account-admin-client.js";
import type { AccountApiError } from "../account/account-admin-client.js";

const lineUserId = `U${"a".repeat(32)}`;
const createInput = {
  expectedLineUserId: lineUserId,
  profileName: "helper",
  channelId: "channel-destination",
  presentation: {
    displayName: "小哈",
    lineId: "@hhc-helper",
    providerId: "provider-1"
  }
};
const finalizeInput = {
  nonce: "native-nonce",
  result: "ok" as const,
  actualLineUserId: lineUserId,
  profileName: "helper",
  channelId: "channel-destination",
  webhookEventId: "01HLINEEVENT"
};
const aclSubjectSearchInput = {
  requestingUserId: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
  subjectType: "user" as const,
  query: "Ada",
  page: 2,
  perPage: 20,
  requestId: "request-1"
};

describe("account admin client", () => {
  it("verifies only media-sync:manage with the propagated request ID", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ allowed: true }));
    const client = createAccountAdminClient({
      baseUrl: "http://127.0.0.1:3500/v1.0/invoke/account-api/method",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(
      client.verifyPermission({
        userId: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
        requestId: "request-1"
      })
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3500/v1.0/invoke/account-api/method/priv/account/v1/permissions/verify",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hhc-request-id": "request-1"
        },
        body: JSON.stringify({
          userId: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
          permission: "media-sync:manage"
        }),
        redirect: "manual"
      })
    );
  });

  it("searches ACL subjects through the exact internal Account contract", async () => {
    const payload = {
      subjects: [
        {
          id: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
          type: "user",
          displayName: "Ada Lovelace",
          email: "ada@example.com"
        }
      ],
      page: 2,
      perPage: 20,
      hasMore: false
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const client = createAccountAdminClient({
      baseUrl: "http://127.0.0.1:3500/v1.0/invoke/account-api/method",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(client.searchMediaSyncAclSubjects(aclSubjectSearchInput)).resolves.toEqual(
      payload
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3500/v1.0/invoke/account-api/method/priv/account/v1/media-sync/acl-subjects/search",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hhc-request-id": "request-1"
        },
        body: JSON.stringify({
          requestingUserId: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
          subjectType: "user",
          query: "Ada",
          page: 2,
          perPage: 20
        }),
        redirect: "manual"
      })
    );
  });

  it("accepts the bounded multibyte display name Account can compose from two profile fields", async () => {
    const displayName = `${"教".repeat(255)} ${"家".repeat(255)}`;
    const payload = {
      subjects: [
        {
          id: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
          type: "user",
          displayName
        }
      ],
      page: 2,
      perPage: 20,
      hasMore: false
    };
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
    });

    await expect(client.searchMediaSyncAclSubjects(aclSubjectSearchInput)).resolves.toEqual(
      payload
    );
    expect(Buffer.byteLength(displayName, "utf8")).toBe(1531);
  });

  it("accepts the legacy System Admin login identifier in the email field", async () => {
    const payload = {
      subjects: [
        {
          id: "019faf9e-238c-7332-9abd-9b4c72412cb9",
          type: "user",
          displayName: "System Admin",
          email: "admin"
        }
      ],
      page: 2,
      perPage: 20,
      hasMore: false
    };
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
    });

    await expect(client.searchMediaSyncAclSubjects(aclSubjectSearchInput)).resolves.toEqual(
      payload
    );
  });

  it.each([
    ["unknown envelope field", { trace: "secret" }],
    ["wrong page", { page: 1 }],
    ["wrong page size", { perPage: 50 }],
    ["non-boolean continuation", { hasMore: "false" }],
    [
      "unknown subject field",
      {
        subjects: [
          {
            id: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
            type: "user",
            displayName: "Ada Lovelace",
            secret: "hidden"
          }
        ]
      }
    ],
    [
      "blank user email",
      {
        subjects: [
          {
            id: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
            type: "user",
            displayName: "Ada Lovelace",
            email: ""
          }
        ]
      }
    ],
    [
      "mixed subject type",
      { subjects: [{ id: "admin", type: "role", displayName: "Administrator" }] }
    ],
    [
      "blank subject identifier",
      { subjects: [{ id: "", type: "user", displayName: "Ada Lovelace" }] }
    ],
    [
      "blank display name",
      {
        subjects: [{ id: "018f0c1f-18d0-7e81-9f6f-69c456db7003", type: "user", displayName: "" }]
      }
    ],
    [
      "oversized subject identifier",
      { subjects: [{ id: "a".repeat(256), type: "user", displayName: "Ada Lovelace" }] }
    ],
    [
      "oversized multibyte display name",
      {
        subjects: [
          {
            id: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
            type: "user",
            displayName: "界".repeat(683)
          }
        ]
      }
    ],
    [
      "more subjects than requested",
      {
        subjects: Array.from({ length: 21 }, (_, index) => ({
          id: `role-${index}`,
          type: "user",
          displayName: `User ${index}`
        }))
      }
    ]
  ])("rejects a malformed ACL subject response: %s", async (_label, override) => {
    const payload = {
      subjects: [
        {
          id: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
          type: "user",
          displayName: "Ada Lovelace"
        }
      ],
      page: 2,
      perPage: 20,
      hasMore: false,
      ...override
    };
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
    });

    await expect(client.searchMediaSyncAclSubjects(aclSubjectSearchInput)).rejects.toMatchObject({
      message: "account_api_invalid_acl_subjects",
      retryable: false
    });
  });

  it("rejects email on role subjects", async () => {
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          subjects: [
            { id: "admin", type: "role", displayName: "admin", email: "admin@example.com" }
          ],
          page: 2,
          perPage: 20,
          hasMore: false
        })
      )
    });

    await expect(
      client.searchMediaSyncAclSubjects({ ...aclSubjectSearchInput, subjectType: "role" })
    ).rejects.toMatchObject({ message: "account_api_invalid_acl_subjects", retryable: false });
  });

  it.each([{ allowed: true, roles: ["admin"] }, { allowed: "true" }, { denied: true }])(
    "rejects malformed permission decisions",
    async (payload) => {
      const client = createAccountAdminClient({
        baseUrl: "http://account-api",
        timeoutMs: 1000,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
      });

      await expect(
        client.verifyPermission({
          userId: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
          requestId: "request-1"
        })
      ).rejects.toMatchObject({
        message: "account_api_invalid_permission_decision",
        retryable: false
      });
    }
  );

  it("verifies configured Account RBAC functions without accepting permission strings", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ configured_functions: ["update_own_profile"] }));
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(
      client.verifyFunctionPermissions({
        profileName: "main",
        functionNames: ["update_own_profile", "find_resource"]
      })
    ).resolves.toEqual(["update_own_profile"]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      profile_name: "main",
      function_names: ["update_own_profile", "find_resource"]
    });
  });

  it("updates only the signed LINE caller's bounded profile names", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          first_name: "Ray",
          last_name: "Self",
          updated_at: "2026-08-09T12:00:00Z"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(
      client.updateOwnProfile({
        lineUserId,
        profileName: "main",
        firstName: "Ray",
        lastName: "Self"
      })
    ).resolves.toEqual({ firstName: "Ray", lastName: "Self" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://account-api/priv/account/v1/line/profile",
      expect.objectContaining({
        body: JSON.stringify({
          line_user_id: lineUserId,
          profile_name: "main",
          first_name: "Ray",
          last_name: "Self"
        })
      })
    );
  });

  it("rejects profile update responses containing identity or permission fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          first_name: "Ray",
          last_name: "Self",
          updated_at: "2026-08-09T12:00:00Z",
          user_id: "internal-user-id"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(
      client.updateOwnProfile({
        lineUserId,
        profileName: "main",
        firstName: "Ray",
        lastName: "Self"
      })
    ).rejects.toMatchObject({
      message: "account_api_invalid_profile_update",
      retryable: false
    });
  });

  it("authorizes through Dapr without spoofing caller identity headers", async () => {
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
    const [, request] = fetchImpl.mock.calls[0]!;
    expect(request).toMatchObject({
      method: "POST",
      body: JSON.stringify({ line_user_id: lineUserId })
    });
    expect(new Headers(request?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(request?.headers).has("x-internal-caller-app-id")).toBe(false);
    expect(new Headers(request?.headers).has("dapr-caller-app-id")).toBe(false);
  });

  it("creates a binding with trusted presentation and no Messaging API link token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          binding_url: "https://account.alive.org.tw/line/bind#token=opaque",
          expires_at: "2026-08-08T12:00:00Z"
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(client.createBinding(createInput)).resolves.toEqual({
      bindingUrl: "https://account.alive.org.tw/line/bind#token=opaque",
      expiresAt: "2026-08-08T12:00:00Z"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://account-api/priv/account/v1/line/bindings",
      expect.objectContaining({
        body: JSON.stringify({
          expected_line_user_id: lineUserId,
          profile_name: "helper",
          channel_id: "channel-destination",
          line_account_name: "小哈",
          line_account_id: "@hhc-helper"
        })
      })
    );
  });

  it("authorizes a bounded function set and returns only canonical sanitized account state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          bound: true,
          active: true,
          administrator: true,
          allowed_functions: ["query_schedule"],
          account: {
            display_name: "Ada Lovelace",
            masked_email: "a***@example.com",
            roles: ["admin", "user"]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(
      client.authorizeFunctions({
        lineUserId,
        profileName: "helper",
        functionNames: ["query_schedule", "find_resource"]
      })
    ).resolves.toEqual({
      bound: true,
      active: true,
      administrator: true,
      allowedFunctions: ["query_schedule"],
      account: {
        displayName: "Ada Lovelace",
        maskedEmail: "a***@example.com",
        roles: ["admin", "user"]
      }
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      line_user_id: lineUserId,
      profile_name: "helper",
      function_names: ["query_schedule", "find_resource"]
    });
  });

  it.each([
    ["raw email", { account: { display_name: "Ada", masked_email: "ada@example.com", roles: [] } }],
    [
      "unknown role",
      { account: { display_name: "Ada", masked_email: "a***@example.com", roles: ["owner"] } }
    ],
    ["unknown function", { allowed_functions: ["delete_everything"] }],
    ["unrequested function", { allowed_functions: ["find_ppt_slides"] }],
    ["unexpected identifier", { user_id: "internal-user" }],
    [
      "noncanonical roles",
      {
        account: { display_name: "Ada", masked_email: "a***@example.com", roles: ["user", "admin"] }
      }
    ],
    ["inactive account details", { active: false }]
  ])("rejects a noncanonical authorization response: %s", async (_label, override) => {
    const payload = {
      bound: true,
      active: true,
      administrator: false,
      allowed_functions: ["query_schedule"],
      account: {
        display_name: "Ada",
        masked_email: "a***@example.com",
        roles: ["user"]
      },
      ...override
    };
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    });

    await expect(
      client.authorizeFunctions({
        lineUserId,
        profileName: "helper",
        functionNames: ["query_schedule", "find_resource"]
      })
    ).rejects.toMatchObject({
      message: "account_api_invalid_function_authorization",
      retryable: false
    });
  });

  it("does not follow Account API redirects", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://evil.example/authorize" } })
      );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(client.authorizeAdministrator(lineUserId)).rejects.toMatchObject({
      message: "account_api_http_302",
      retryable: false
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("finalizes native LINE account-link events with an exact payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(client.finalizeBinding(finalizeInput)).resolves.toEqual({
      status: "completed"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://account-api/priv/account/v1/line/bindings/finalize",
      expect.objectContaining({
        body: JSON.stringify({
          nonce: "native-nonce",
          result: "ok",
          actual_line_user_id: lineUserId,
          profile_name: "helper",
          channel_id: "channel-destination",
          webhook_event_id: "01HLINEEVENT"
        })
      })
    );
  });

  it("omits the actual user id when LINE reports a failed link", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "failed" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl
    });

    await client.finalizeBinding({
      ...finalizeInput,
      result: "failed",
      actualLineUserId: undefined
    });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      nonce: "native-nonce",
      result: "failed",
      profile_name: "helper",
      channel_id: "channel-destination",
      webhook_event_id: "01HLINEEVENT"
    });
  });

  it.each([
    ["legacy query token", "https://account.alive.org.tw/line/bind?token=opaque"],
    ["wrong host", "https://evil.example/line/bind#token=opaque"],
    ["blank fragment token", "https://account.alive.org.tw/line/bind#token="],
    ["extra fragment field", "https://account.alive.org.tw/line/bind#token=opaque&next=evil"],
    ["duplicate token", "https://account.alive.org.tw/line/bind#token=one&token=two"],
    ["userinfo", "https://user@account.alive.org.tw/line/bind#token=opaque"],
    ["encoded control", "https://account.alive.org.tw/line/bind#token=%00opaque"],
    ["encoded whitespace", "https://account.alive.org.tw/line/bind#token=%20opaque%20"]
  ])("rejects a non-canonical binding URL: %s", async (_label, bindingUrl) => {
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ binding_url: bindingUrl, expires_at: "2026-08-08T12:00:00Z" }),
            { status: 201, headers: { "content-type": "application/json" } }
          )
        )
    });

    await expect(client.createBinding(createInput)).rejects.toMatchObject({
      message: "account_api_invalid_binding",
      retryable: false
    });
  });

  it.each([
    [503, true],
    [429, true],
    [408, true],
    [400, false]
  ])("classifies Account API HTTP %s failures", async (status, retryable) => {
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
    });

    await expect(client.finalizeBinding(finalizeInput)).rejects.toEqual(
      expect.objectContaining<AccountApiError>({ retryable })
    );
  });

  it("classifies transport failures as retryable without exposing their message", async () => {
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("native-nonce leaked"))
    });

    await expect(client.finalizeBinding(finalizeInput)).rejects.toMatchObject({
      message: "account_api_transport_error",
      retryable: true
    });
  });

  it("rejects malformed terminal responses as permanent", async () => {
    const client = createAccountAdminClient({
      baseUrl: "http://account-api",
      timeoutMs: 1000,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ status: "created" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    });

    await expect(client.finalizeBinding(finalizeInput)).rejects.toMatchObject({
      message: "account_api_invalid_finalize",
      retryable: false
    });
  });
});
