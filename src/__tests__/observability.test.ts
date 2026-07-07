import { describe, expect, it, vi } from "vitest";

import {
  redactSensitiveText,
  sanitizeActionTelemetryEvent
} from "../observability/action-telemetry.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import { createConsoleRouteObserver } from "../observability/route-observer.js";

describe("observability sanitization", () => {
  it("drops raw text, invite codes, tokens, ids, and urls from telemetry events", () => {
    const sanitized = sanitizeActionTelemetryEvent({
      kind: "route",
      requestId: "req-1",
      profileName: "helper",
      sourceType: "user",
      provider: "ollama",
      outcome: "execute",
      action: "find_ppt_slides",
      confidence: 0.91,
      durationMs: 12,
      text: "小哈 查奇異恩典",
      query: "奇異恩典",
      inviteCode: "ADMINOBS",
      replyToken: "reply-token",
      lineUserId: "U123",
      url: "https://example.invalid/download?token=secret"
    });

    expect(sanitized).toEqual({
      kind: "route",
      requestId: "req-1",
      profileName: "helper",
      sourceType: "user",
      provider: "ollama",
      outcome: "execute",
      action: "find_ppt_slides",
      confidence: 0.91,
      durationMs: 12
    });
    expect(JSON.stringify(sanitized)).not.toContain("奇異恩典");
    expect(JSON.stringify(sanitized)).not.toContain("ADMINOBS");
    expect(JSON.stringify(sanitized)).not.toContain("reply-token");
    expect(JSON.stringify(sanitized)).not.toContain("U123");
    expect(JSON.stringify(sanitized)).not.toContain("token=secret");
  });

  it("redacts sensitive strings in error messages", () => {
    expect(
      redactSensitiveText("failed url=https://example.invalid/path?token=abc secret=abc123")
    ).toBe("failed url=[url] secret=[redacted]");
  });

  it("sanitizes last route records before storing them", async () => {
    const store = new InMemoryLastRouteStore(10);

    await store.record({
      requestId: "req-1",
      occurredAt: "2026-07-07T00:00:00.000Z",
      profileName: "helper",
      sourceType: "user",
      phase: "route",
      provider: "ollama",
      outcome: "execute",
      action: "find_ppt_slides",
      query: "奇異恩典",
      inviteCode: "ADMINOBS"
    } as never);

    const [record] = await store.list();

    expect(record).toMatchObject({
      query: "present"
    });
    expect(JSON.stringify(record)).not.toContain("奇異恩典");
    expect(JSON.stringify(record)).not.toContain("ADMINOBS");
  });

  it("sanitizes last error messages before storing them", async () => {
    const store = new InMemoryLastErrorStore(10);

    await store.record({
      requestId: "req-1",
      occurredAt: "2026-07-07T00:00:00.000Z",
      profileName: "helper",
      sourceType: "user",
      phase: "router",
      errorName: "Error",
      message: "secret=abc123 https://example.invalid/path?token=abc"
    });

    const [record] = await store.list();

    expect(record?.message).toBe("secret=[redacted] [url]");
  });

  it("sanitizes console route observer output", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const observer = createConsoleRouteObserver();

    await observer({
      kind: "route",
      profileName: "helper",
      sourceType: "user",
      requestId: "req-1",
      action: "find_ppt_slides",
      text: "小哈 查奇異恩典",
      inviteCode: "ADMINOBS"
    } as never);

    const payload = String(info.mock.calls[0]?.[0]);

    expect(payload).toContain("find_ppt_slides");
    expect(payload).not.toContain("奇異恩典");
    expect(payload).not.toContain("ADMINOBS");
    info.mockRestore();
  });
});
