import { describe, expect, it, vi } from "vitest";

import { AccountApiError } from "../account/account-admin-client.js";
import { runAccountDeploymentPreflight } from "../assurance/account-deployment-preflight.js";

describe("account deployment preflight", () => {
  it("keeps identity and binding checks when no function requires RBAC", async () => {
    const verifyFunctionPermissions = vi.fn();
    const result = await runAccountDeploymentPreflight(
      [{ profileName: "main", functionNames: [] }],
      {
        verifyFunctionPermissions,
        authorizeFunctions: vi.fn().mockResolvedValue({
          bound: false,
          active: false,
          administrator: false,
          allowedFunctions: []
        }),
        finalizeBinding: vi
          .fn()
          .mockRejectedValue(new AccountApiError("account_api_http_410", false))
      }
    );

    expect(result).toEqual({
      status: "passed",
      functions: [],
      outcomes: { identityLookup: "unbound", binding: "rejected" }
    });
    expect(verifyFunctionPermissions).not.toHaveBeenCalled();
  });

  it("reports only function names and bounded outcomes", async () => {
    const result = await runAccountDeploymentPreflight(
      [{ profileName: "main", functionNames: ["update_own_profile"] }],
      {
        verifyFunctionPermissions: vi.fn().mockResolvedValue(["update_own_profile"]),
        authorizeFunctions: vi.fn().mockResolvedValue({
          bound: false,
          active: false,
          administrator: false,
          allowedFunctions: []
        }),
        finalizeBinding: vi
          .fn()
          .mockRejectedValue(new AccountApiError("account_api_http_410", false))
      }
    );

    expect(result).toEqual({
      status: "passed",
      functions: [{ name: "update_own_profile", outcome: "configured" }],
      outcomes: { identityLookup: "unbound", binding: "rejected" }
    });
    expect(JSON.stringify(result)).not.toMatch(
      /line_user_id|profile_name|permission|email|nonce|https?:|@/u
    );
  });

  it("fails closed when a required permission record is missing", async () => {
    const result = await runAccountDeploymentPreflight(
      [{ profileName: "main", functionNames: ["update_own_profile"] }],
      {
        verifyFunctionPermissions: vi.fn().mockResolvedValue([]),
        authorizeFunctions: vi.fn().mockResolvedValue({
          bound: false,
          active: false,
          administrator: false,
          allowedFunctions: []
        }),
        finalizeBinding: vi
          .fn()
          .mockRejectedValue(new AccountApiError("account_api_http_410", false))
      }
    );

    expect(result).toEqual({
      status: "failed",
      functions: [{ name: "update_own_profile", outcome: "missing" }],
      outcomes: { identityLookup: "unbound", binding: "rejected" }
    });
  });
});
