import { describe, expect, it } from "vitest";

import { projectAgentReply } from "../agent/response-projector.js";
import type { FunctionExecutionResult } from "../types.js";

function scheduleResult(): FunctionExecutionResult {
  const replyText = [
    "7月16日 晨更服事表",
    "- 直播：鏽姐、家睿",
    "- 音控：資恆",
    "- 投影電腦：家怡"
  ].join("\n");
  return {
    ok: true,
    replyText,
    agentResult: {
      status: "success",
      replyText,
      replyData: {
        kind: "schedule",
        fields: { date: "7月16日", meeting: "晨更" },
        records: [
          { role: "直播", people: "鏽姐、家睿", date: "7月16日", meeting: "晨更" },
          { role: "音控", people: "資恆", date: "7月16日", meeting: "晨更" },
          { role: "投影電腦", people: "家怡", date: "7月16日", meeting: "晨更" }
        ]
      }
    }
  };
}

describe("response projector", () => {
  it("returns only the requested schedule role", () => {
    const projected = projectAgentReply({
      capability: "query_schedule",
      text: "直播是誰",
      result: scheduleResult()
    });

    expect(projected.replyText).toBe("直播：鏽姐、家睿");
    expect(projected.replyText).not.toContain("音控");
    expect(projected.agentResult?.projectionHint).toBe("focused");
  });

  it("returns a declared field without the full record", () => {
    const projected = projectAgentReply({
      capability: "query_schedule",
      text: "日期是哪一天",
      result: scheduleResult()
    });

    expect(projected.replyText).toBe("日期：7月16日");
  });

  it("keeps the full fallback only when explicitly requested", () => {
    const original = scheduleResult();
    const projected = projectAgentReply({
      capability: "query_schedule",
      text: "給我完整服事表",
      result: original
    });

    expect(projected.replyText).toBe(original.replyText);
    expect(projected.agentResult?.projectionHint).toBe("full");
  });

  it("projects generic declared answer and link fields", () => {
    const result: FunctionExecutionResult = {
      ok: true,
      replyText: "完整結果",
      agentResult: {
        status: "success",
        replyText: "完整結果",
        replyData: {
          kind: "resource",
          fields: { title: "奔跑不放棄", link: "https://example.test/file" }
        }
      }
    };

    expect(
      projectAgentReply({ capability: "find_sheet_music", text: "連結給我", result }).replyText
    ).toBe("連結：https://example.test/file");
  });

  it("does not mistake a capability wrapper for a requested response field", () => {
    const result: FunctionExecutionResult = {
      ok: true,
      replyText: "牧師師母 50 週年\nhttps://example.test/file",
      agentResult: {
        status: "success",
        replyText: "牧師師母 50 週年\nhttps://example.test/file",
        replyData: {
          kind: "resource",
          fields: { title: "牧師師母 50 週年", link: "https://example.test/file" }
        }
      }
    };

    expect(
      projectAgentReply({
        capability: "find_resource",
        text: "查教會資料 牧師師母 50 週年",
        result
      }).replyText
    ).toBe(result.replyText);
  });
});
