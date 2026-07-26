import { describe, expect, it } from "vitest";

import type { AgentResultEnvelope } from "../agent/result-envelope.js";
import type { FunctionExecutionResult, QuickReplyItem } from "../types.js";
import { getFunctionDefinition } from "../functions/definitions.js";
import {
  applyResultGuidance,
  type ControlledResultState
} from "../application/turn/result-guidance.js";

const existingChoice: QuickReplyItem = {
  label: "第一個結果",
  action: {
    type: "postback",
    label: "第一個結果",
    data: "action=select&index=0"
  }
};

function baseResult(state: ControlledResultState): FunctionExecutionResult {
  const status =
    state === "ambiguous" ||
    state === "not_found" ||
    state === "unavailable" ||
    state === "success" ||
    state === "stale_allowed"
      ? state === "stale_allowed"
        ? "success"
        : state
      : undefined;
  return {
    ok: state !== "error",
    replyText: state === "success" || state === "stale_allowed" ? "聚焦結果" : "原本的安全說明",
    quickReplies: [existingChoice, { ...existingChoice, label: "第二個結果" }],
    ...(status
      ? {
          agentResult: {
            status,
            replyText: "受控結果",
            anchors: { resourceId: "opaque-resource" },
            supportedOperations: ["continue"]
          } satisfies AgentResultEnvelope
        }
      : {})
  };
}

describe("controlled result guidance", () => {
  it.each([
    ["permission_denied", "/help", 1],
    ["missing_input", "請", 1],
    ["not_found", "換一個關鍵字", 1],
    ["unavailable", "稍後再試", 1],
    ["stale_allowed", "資料時間", 0]
  ] satisfies Array<[ControlledResultState, string, number]>)(
    "gives %s a reason and no more than its bounded next action",
    (state, phrase, maxActions) => {
      const guided = applyResultGuidance({
        state,
        result: baseResult(state),
        staleAt: state === "stale_allowed" ? "2026-07-26T08:00:00.000Z" : undefined
      });

      expect(guided.replyText).toContain(phrase);
      expect(guided.quickReplies?.length ?? 0).toBeLessThanOrEqual(maxActions);
    }
  );

  it("uses the definition-owned missing-slot prompt and keeps only one bounded choice", () => {
    const definition = getFunctionDefinition("query_schedule");
    const guided = applyResultGuidance({
      state: "missing_input",
      result: { ...baseResult("missing_input"), replyText: "" },
      definition
    });

    expect(guided.replyText).toContain(definition?.clarificationPrompt);
    expect(guided.replyText).toContain("請");
    expect(guided.quickReplies).toEqual([existingChoice]);
  });

  it("preserves grounded ambiguity choices and controlled metadata", () => {
    const result = baseResult("ambiguous");
    const guided = applyResultGuidance({ state: "ambiguous", result });

    expect(guided.replyText).toBe(result.replyText);
    expect(guided.quickReplies).toEqual(result.quickReplies);
    expect(guided.agentResult).toBe(result.agentResult);
  });

  it("preserves a focused success result and its reply data", () => {
    const result = {
      ...baseResult("success"),
      responseData: {
        kind: "schedule",
        fields: { role: "音控", people: "小明" }
      }
    };

    const guided = applyResultGuidance({ state: "success", result });

    expect(guided).toEqual(result);
    expect(guided.agentResult).toBe(result.agentResult);
    expect(guided.responseData).toBe(result.responseData);
  });

  it("offers the full result only when the capability supports it", () => {
    const result = { ...baseResult("success"), quickReplies: undefined };

    expect(
      applyResultGuidance({ state: "success", result, supportsViewFull: false }).quickReplies
    ).toBeUndefined();
    const guided = applyResultGuidance({ state: "success", result, supportsViewFull: true });
    expect(guided.quickReplies).toEqual([
      {
        label: "查看完整結果",
        action: {
          type: "message",
          label: "查看完整結果",
          text: "查看完整結果"
        }
      }
    ]);
    expect(guided.replyText).toBe(result.replyText);
    expect(guided.agentResult).toBe(result.agentResult);
  });

  it("keeps error copy and removes speculative next actions", () => {
    const result = {
      ...baseResult("error"),
      replyText: "處理請求時發生錯誤，請稍後再試。（支援碼：ABC123）"
    };

    const guided = applyResultGuidance({ state: "error", result });

    expect(guided.replyText).toBe(result.replyText);
    expect(guided.quickReplies).toBeUndefined();
    expect(guided.agentResult).toBe(result.agentResult);
  });

  it("keeps ordinary guidance free of implementation details", () => {
    const output = (
      [
        "permission_denied",
        "missing_input",
        "not_found",
        "unavailable",
        "stale_allowed",
        "error"
      ] satisfies ControlledResultState[]
    )
      .map((state) =>
        applyResultGuidance({
          state,
          result: { ...baseResult(state), replyText: state === "error" ? "安全錯誤說明" : "" }
        }).replyText.toLowerCase()
      )
      .join("\n");

    for (const forbidden of [
      "deepseek",
      "openai",
      "onedrive",
      "notion",
      "postgres",
      "redis",
      "provider",
      "model",
      "source id"
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });
});
