import { describe, expect, it, vi } from "vitest";

import {
  redactSensitiveText,
  sanitizeActionTelemetryEvent
} from "../observability/action-telemetry.js";
import { createSupportId } from "../observability/opaque-identifiers.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import { createConsoleRouteObserver } from "../observability/route-observer.js";

describe("observability sanitization", () => {
  it("keeps bounded controlled-agent telemetry fields and drops sensitive payloads", () => {
    const sanitized = sanitizeActionTelemetryEvent({
      kind: "route",
      phase: "planner",
      provider: "deepseek",
      disposition: "continue",
      confidenceBucket: "high",
      candidateCount: 2,
      candidates: ["query_schedule", "query_knowledge"],
      validatorReason: "active_task_refinement",
      resultStatus: "success",
      anchorCount: 2,
      entityTypes: ["meeting", "role"],
      lifecycleOutcome: "replace",
      action: "王小明",
      reason: "private evidence",
      text: "王小明",
      prompt: "private system prompt",
      evidence: "private evidence",
      url: "https://example.invalid/private",
      filename: "主日服事表.xlsx",
      token: "secret-token"
    });

    expect(sanitized).toEqual({
      kind: "route",
      phase: "planner",
      provider: "deepseek",
      disposition: "continue",
      confidenceBucket: "high",
      candidateCount: 2,
      candidates: ["query_schedule", "query_knowledge"],
      validatorReason: "active_task_refinement",
      resultStatus: "success",
      anchorCount: 2,
      entityTypes: ["meeting", "role"],
      lifecycleOutcome: "replace"
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /王小明|private system prompt|private evidence|example\.invalid|主日服事表|secret-token/u
    );
  });

  it("drops raw text, invite codes, tokens, ids, and urls from telemetry events", () => {
    const sanitized = sanitizeActionTelemetryEvent({
      kind: "route",
      requestId: "req-1",
      profileName: "helper",
      sourceType: "user",
      provider: "ollama",
      lane: "function_routing",
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
      supportId: createSupportId("req-1"),
      profileName: "configured",
      sourceType: "user",
      provider: "ollama",
      lane: "function_routing",
      outcome: "execute",
      action: "find_ppt_slides",
      durationMs: 12
    });
    expect(JSON.stringify(sanitized)).not.toContain("奇異恩典");
    expect(JSON.stringify(sanitized)).not.toContain("ADMINOBS");
    expect(JSON.stringify(sanitized)).not.toContain("reply-token");
    expect(JSON.stringify(sanitized)).not.toContain("U123");
    expect(JSON.stringify(sanitized)).not.toContain("token=secret");
  });

  it("keeps only bounded retrieval diagnostics", () => {
    const sanitized = sanitizeActionTelemetryEvent({
      kind: "function_result",
      requestId: "req-1",
      profileName: "helper",
      sourceType: "user",
      executionMode: "catalog_snapshot_read",
      stateAgeBucket: "under_10m",
      freshnessStatus: "fresh",
      sourceRevision: "present",
      queryFingerprint: "0123456789abcdef",
      referenceFingerprint: "fedcba9876543210",
      rawQuery: "牧師師母五十週年",
      title: "private-title.pptx",
      url: "https://example.invalid/private"
    });

    expect(sanitized).toMatchObject({
      executionMode: "catalog_snapshot_read",
      stateAgeBucket: "under_10m",
      freshnessStatus: "fresh",
      sourceRevision: "present",
      queryFingerprint: "0123456789abcdef",
      referenceFingerprint: "fedcba9876543210"
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/牧師|private-title|example\.invalid/u);
  });

  it("fails closed for arbitrary strings in non-controlled telemetry", () => {
    const sanitized = sanitizeActionTelemetryEvent({
      kind: "function_error",
      requestId: "request-secret-id",
      profileName: "private-profile-id",
      sourceType: "group",
      phase: "function",
      provider: "unknown-provider-secret",
      lane: "private-lane",
      outcome: "private-outcome",
      action: "王小明",
      reason: "bare-secret-evidence",
      fallbackProvider: "private-provider",
      fallbackReason: "主日服事表.xlsx",
      handler: "private-handler",
      command: "invite_code=SECRET123",
      errorName: "private-error-name",
      engagement: "private-engagement",
      smallTalkCategory: "private-category",
      dedup: "drive-item-secret",
      queryHash: "private-query-id",
      authorized: true,
      ok: false,
      durationMs: 999_999
    });

    expect(sanitized).toEqual({
      kind: "function_error",
      supportId: createSupportId("request-secret-id"),
      profileName: "configured",
      sourceType: "group",
      phase: "function",
      errorName: "Error",
      authorized: true,
      ok: false,
      durationMs: 60_000
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /request-secret|private-|王小明|bare-secret|主日服事表|SECRET123|drive-item/u
    );
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
      lane: "function_routing",
      outcome: "execute",
      action: "find_ppt_slides",
      query: "奇異恩典",
      inviteCode: "ADMINOBS"
    } as never);

    const [record] = await store.list();

    expect(record).toMatchObject({
      lane: "function_routing",
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

    expect(record).toEqual({
      supportId: createSupportId("req-1"),
      occurredAt: "2026-07-07T00:00:00.000Z",
      profileName: "configured",
      sourceType: "user",
      phase: "router",
      errorName: "Error",
      message: "redacted"
    });
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
