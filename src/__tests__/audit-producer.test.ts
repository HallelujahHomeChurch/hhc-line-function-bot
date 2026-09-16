import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAuditEvent, loadAuditFixture } from "../audit/catalog.js";
import { createAuditClient } from "../audit/client.js";
import { flushAuditOutbox } from "../audit/dispatcher.js";

const userId = "018f47d2-e5d1-4f3f-8f18-6c8e32621f71";
const resourceId = "4c03465b-8a87-45a2-9d0d-54f904f4e6ab";

describe("central audit producer contract", () => {
  it("pins the exact released LINE fixture checksum", () => {
    const fixture = loadAuditFixture();

    expect(fixture.sourceService).toBe("hhc-line-function-bot");
    expect(fixture.checksum).toBe(
      "sha256:ff521b52ac736ec03e4e614c04b6a7d6d7af2a5cf73f7d4c3906c87ab344812e"
    );
    expect(fixture.actions.map(({ action }) => action)).toEqual([
      "media_sync.binding.create",
      "media_sync.binding.delete",
      "media_sync.binding_code.create"
    ]);
  });

  it("builds only canonical catalog events", () => {
    const event = createAuditEvent({
      action: "media_sync.binding.create",
      resourceId,
      actor: { type: "user", id: userId },
      requestId: "request-1",
      now: new Date("2099-01-01T00:00:00.000Z"),
      eventId: "f4eef490-31e5-4f24-9a90-01018bd0f81c"
    });

    expect(event).toMatchObject({
      schemaVersion: 1,
      sourceService: "hhc-line-function-bot",
      actorType: "user",
      actorId: userId,
      resourceType: "binding",
      resourceId,
      metadata: {}
    });
    expect(() =>
      createAuditEvent({
        action: "media_sync.binding.create",
        resourceId,
        actor: { type: "service", id: "hhc-line-function-bot" },
        requestId: "request-1"
      })
    ).toThrow("audit_event_invalid");
    expect(() =>
      createAuditEvent({
        action: "media_sync.binding.delete",
        resourceId,
        actor: { type: "service", id: "hhc-line-function-bot" },
        requestId: "YWJj.ZGVm.Z2hp"
      })
    ).toThrow("audit_event_invalid");
  });

  it("posts through Dapr with the caller-specific token and bounded body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    const client = createAuditClient({
      appId: "audit-log",
      token: "audit-token",
      daprHttpPort: 3500,
      fetchImpl
    });
    const payload = JSON.stringify(
      createAuditEvent({
        action: "media_sync.binding.delete",
        resourceId,
        actor: { type: "service", id: "hhc-line-function-bot" },
        requestId: "worker:cleanup",
        eventId: "f4eef490-31e5-4f24-9a90-01018bd0f81c"
      })
    );

    await expect(client.append(payload)).resolves.toEqual({ status: "delivered" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3500/v1.0/invoke/audit-log/method/priv/audit/events",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "x-audit-token": "audit-token" },
        body: payload,
        redirect: "manual"
      })
    );
  });

  it("honors a bounded Retry-After cooldown without reading response content", async () => {
    const client = createAuditClient({
      appId: "audit-log",
      token: "audit-token",
      daprHttpPort: 3500,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response("secret body", { status: 429, headers: { "retry-after": "7" } })
        )
    });

    await expect(client.append("{}")).resolves.toEqual({
      status: "retry",
      reason: "http_429",
      retryAfterMs: 7_000
    });
  });
});

describe("central audit dispatcher", () => {
  it("marks delivered, retryable, and terminal outcomes without logging payloads", async () => {
    const rows = [
      outbox("f4eef490-31e5-4f24-9a90-01018bd0f81c", "payload-one"),
      outbox("39f1e2be-722e-4f6b-b62f-793b05a9f0f6", "payload-two"),
      outbox("cf43776f-57a2-42b2-8903-f92048431969", "payload-three")
    ];
    const store = {
      claimAuditOutbox: vi.fn().mockResolvedValue(rows),
      markAuditDelivered: vi.fn().mockResolvedValue(true),
      markAuditRetry: vi.fn().mockResolvedValue(true),
      markAuditTerminal: vi.fn().mockResolvedValue(true)
    };
    const append = vi
      .fn()
      .mockResolvedValueOnce({ status: "delivered" })
      .mockResolvedValueOnce({ status: "retry", reason: "http_429", retryAfterMs: 5_000 })
      .mockResolvedValueOnce({ status: "terminal", reason: "http_400" });

    await expect(
      flushAuditOutbox({ store, client: { append }, limit: 3, leaseMs: 30_000 })
    ).resolves.toEqual({ considered: 3, delivered: 1, retried: 1, terminal: 1 });
    expect(store.markAuditDelivered).toHaveBeenCalledWith(rows[0]);
    expect(store.markAuditRetry).toHaveBeenCalledWith(rows[1], 5_000, "http_429");
    expect(store.markAuditTerminal).toHaveBeenCalledWith(rows[2], "http_400");
  });

  it("dead-letters corrupted payloads and exhausted retries before another send", async () => {
    const corrupted = { ...outbox(resourceId, "payload"), payloadHash: "0".repeat(64) };
    const exhausted = { ...outbox(resourceId, "retry"), attempts: 20 };
    const store = {
      claimAuditOutbox: vi.fn().mockResolvedValue([corrupted, exhausted]),
      markAuditDelivered: vi.fn(),
      markAuditRetry: vi.fn(),
      markAuditTerminal: vi.fn().mockResolvedValue(true)
    };
    const append = vi.fn().mockResolvedValue({ status: "retry", reason: "http_503" });

    await expect(
      flushAuditOutbox({ store, client: { append }, limit: 2, leaseMs: 30_000 })
    ).resolves.toEqual({ considered: 2, delivered: 0, retried: 0, terminal: 2 });
    expect(append).toHaveBeenCalledOnce();
    expect(store.markAuditTerminal).toHaveBeenNthCalledWith(1, corrupted, "invalid_payload");
    expect(store.markAuditTerminal).toHaveBeenNthCalledWith(2, exhausted, "max_attempts");
  });
});

function outbox(eventId: string, payload: string) {
  return {
    eventId,
    payload,
    payloadHash: createHash("sha256").update(payload).digest("hex"),
    attempts: 0,
    claimedUntil: "2099-01-01T00:00:30.000Z"
  };
}
