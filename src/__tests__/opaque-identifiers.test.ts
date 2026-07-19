import { describe, expect, it } from "vitest";

import { createActorFingerprint, createSupportId } from "../observability/opaque-identifiers.js";

describe("opaque observability identifiers", () => {
  it("creates a stable bounded support id without exposing the request id", () => {
    const requestId = "01J4Y8EXAMPLE-request-secret";

    const first = createSupportId(requestId);
    const second = createSupportId(requestId);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/u);
    expect(requestId).not.toContain(first);
    expect(first).not.toContain("example");
  });

  it("domain-separates actor fingerprints by profile source and requester", () => {
    const key = "0123456789abcdef0123456789abcdef";
    const base = {
      profileName: "helper",
      sourceType: "group" as const,
      sourceId: "group-1",
      requesterUserId: "user-1"
    };

    const fingerprint = createActorFingerprint(base, key);

    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(createActorFingerprint(base, key)).toBe(fingerprint);
    expect(createActorFingerprint({ ...base, profileName: "main" }, key)).not.toBe(fingerprint);
    expect(createActorFingerprint({ ...base, sourceId: "group-2" }, key)).not.toBe(fingerprint);
    expect(createActorFingerprint({ ...base, requesterUserId: "user-2" }, key)).not.toBe(
      fingerprint
    );
  });

  it("does not create an actor fingerprint without a requester", () => {
    expect(
      createActorFingerprint(
        { profileName: "helper", sourceType: "group", sourceId: "group-1" },
        "0123456789abcdef0123456789abcdef"
      )
    ).toBeUndefined();
  });
});
