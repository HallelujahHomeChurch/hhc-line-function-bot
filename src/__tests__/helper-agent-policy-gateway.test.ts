import { describe, expect, it, vi } from "vitest";

import { runWithAgentBudget } from "../helper-agent/budget.js";
import { createHelperToolGateway } from "../helper-agent/policy-gateway.js";
import { projectToolResult } from "../helper-agent/tool-result.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  FunctionHandlerContext
} from "../types.js";

function helperContext(
  source: FunctionHandlerContext["event"]["source"] = { type: "user", userId: "U1" }
): FunctionHandlerContext {
  return {
    profile: profile(),
    event: { type: "message", source, message: { type: "text", text: "查服事表" } }
  };
}

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["query_schedule", "save_memory", "save_schedule"],
    permissionRequiredFunctions: [],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function successfulScheduleResult(): FunctionExecutionResult {
  return {
    ok: true,
    replyText: "正式服事表：敬拜同工",
    agentResult: {
      status: "success",
      replyText: "服事表查詢完成。",
      replyData: {
        kind: "schedule",
        fields: { meeting: "主日" },
        records: [{ date: "2026-09-06", role: "敬拜", people: "同工甲" }]
      }
    }
  };
}

describe("helper tool policy gateway", () => {
  it("rechecks authorization immediately before every handler call", async () => {
    const handler = vi.fn(async () => successfulScheduleResult());
    const gateway = createHelperToolGateway({
      handlers: { query_schedule: handler },
      context: helperContext(),
      authorize: async () => false
    });

    await expect(gateway.execute("query_schedule", { query: "查服事表" })).resolves.toEqual({
      status: "denied",
      sourceType: "official"
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a room source, malformed arguments, and model confirmation before handlers", async () => {
    const handler = vi.fn(async () => successfulScheduleResult());
    const roomGateway = createHelperToolGateway({
      handlers: { query_schedule: handler },
      context: helperContext({ type: "room", roomId: "R1", userId: "U1" })
    });
    const userGateway = createHelperToolGateway({
      handlers: { query_schedule: handler, save_memory: handler, save_schedule: handler },
      context: helperContext(),
      authorize: async () => true
    });

    await expect(
      roomGateway.execute("query_schedule", { query: "查服事表" })
    ).resolves.toMatchObject({
      status: "denied"
    });
    await expect(
      userGateway.execute("query_schedule", { dateIntent: "specific_date" })
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      userGateway.execute("save_memory", { content: "待確認資料", confirm: true })
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      userGateway.execute("save_schedule", {
        operation: "add_entry",
        entry: {
          serviceDate: "2026-09-06",
          meetingName: "主日",
          assignee: "同工甲",
          untrusted: "model-only"
        }
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("accounts for denied attempts in the shared tool budget", async () => {
    const gateway = createHelperToolGateway({ handlers: {}, context: helperContext() });

    await expect(
      runWithAgentBudget("normal", async () => {
        for (let index = 0; index < 5; index += 1) {
          await gateway.execute("query_schedule", { query: "查服事表" });
        }
      })
    ).rejects.toThrow("agent_tool_budget_exceeded");
  });

  it("keeps schedule and saved-note authority distinct", () => {
    expect(projectToolResult(successfulScheduleResult(), "official").sourceType).toBe("official");
    expect(projectToolResult(successfulScheduleResult(), "saved_note").sourceType).toBe(
      "saved_note"
    );
  });

  it("removes links and internal fields while capping records before model exposure", () => {
    const projected = projectToolResult(
      {
        ok: true,
        replyText: "https://temporary.example/private",
        responseData: {
          kind: "resource",
          fields: { link: "https://temporary.example/private" }
        },
        agentResource: {
          resourceType: "ppt_slide",
          title: "private.pptx",
          storage: { provider: "graph", driveId: "drive-1", itemId: "item-1" }
        },
        agentResult: {
          status: "success",
          replyText: "不應暴露的回覆",
          replyData: {
            kind: "schedule",
            fields: { sourceId: "source-1", meeting: "主日" },
            records: Array.from({ length: 20 }, (_, index) => ({
              date: `2026-09-${String(index + 1).padStart(2, "0")}`,
              documentId: `document-${index}`,
              link: "https://temporary.example/private"
            }))
          }
        }
      },
      "knowledge"
    );

    expect(projected.data?.records).toHaveLength(10);
    expect(JSON.stringify(projected)).not.toContain("https://temporary.example");
    expect(JSON.stringify(projected)).not.toMatch(/source-1|document-/u);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(2_000);
  });
});
