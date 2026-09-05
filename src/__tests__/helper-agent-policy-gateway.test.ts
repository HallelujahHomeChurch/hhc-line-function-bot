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
    schedulePolicy: { meetingReferences: [], domains: [] }
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
  it("assigns callback order at invocation time without serializing handlers", async () => {
    let releaseFirst!: (result: FunctionExecutionResult) => void;
    const firstResult = new Promise<FunctionExecutionResult>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = vi.fn(async (args: Record<string, unknown>) =>
      args.query === "first" ? firstResult : successfulScheduleResult()
    );
    const observed: Array<{ query: unknown; order: number }> = [];
    const gateway = createHelperToolGateway({
      handlers: { query_schedule: handler },
      context: helperContext(),
      onDomainResult: (_name, args, _result, order) => {
        observed.push({ query: args.query, order });
      }
    });

    const first = gateway.execute("query_schedule", { query: "first" }, "official");
    const second = gateway.execute("query_schedule", { query: "second" }, "official");
    await second;
    expect(observed).toEqual([{ query: "second", order: 2 }]);
    releaseFirst(successfulScheduleResult());
    await first;

    expect(observed).toEqual([
      { query: "second", order: 2 },
      { query: "first", order: 1 }
    ]);
  });

  it("rechecks authorization immediately before every handler call", async () => {
    const handler = vi.fn(async () => successfulScheduleResult());
    const gateway = createHelperToolGateway({
      handlers: { query_schedule: handler },
      context: helperContext(),
      authorize: async () => false
    });

    await expect(
      gateway.execute("query_schedule", { query: "查服事表" }, "official")
    ).resolves.toEqual({ status: "denied", sourceType: "official" });
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
      roomGateway.execute("query_schedule", { query: "查服事表" }, "official")
    ).resolves.toMatchObject({
      status: "denied"
    });
    await expect(
      userGateway.execute("query_schedule", { dateIntent: "specific_date" }, "official")
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      userGateway.execute("save_memory", { content: "待確認資料", confirm: true }, "saved_note")
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      userGateway.execute(
        "save_schedule",
        {
          operation: "add_entry",
          entry: {
            serviceDate: "2026-09-06",
            meetingName: "主日",
            assignee: "同工甲",
            untrusted: "model-only"
          }
        },
        "official"
      )
    ).resolves.toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("accounts for denied attempts in the shared tool budget", async () => {
    const gateway = createHelperToolGateway({ handlers: {}, context: helperContext() });

    await expect(
      runWithAgentBudget("normal", async () => {
        for (let index = 0; index < 5; index += 1) {
          await gateway.execute("query_schedule", { query: "查服事表" }, "official");
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

  it("requires callers to supply source authority", () => {
    const gateway = createHelperToolGateway({ handlers: {}, context: helperContext() });

    expect(gateway.execute).toHaveLength(3);
  });

  it("fails closed for a permission-required read without a live authorizer", async () => {
    const handler = vi.fn(async () => successfulScheduleResult());
    const context = helperContext();
    context.profile = { ...context.profile, permissionRequiredFunctions: ["query_schedule"] };
    const gateway = createHelperToolGateway({ context, handlers: { query_schedule: handler } });

    await expect(
      gateway.execute("query_schedule", { query: "查服事表" }, "official")
    ).resolves.toEqual({ status: "denied", sourceType: "official" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("converts authorization and handler failures to unavailable results", async () => {
    const unavailable = { status: "unavailable", sourceType: "official" };
    const authorizationFailure = createHelperToolGateway({
      context: helperContext(),
      handlers: { query_schedule: vi.fn(async () => successfulScheduleResult()) },
      authorize: async () => {
        throw new Error("authorization secret");
      }
    });
    const handlerFailure = createHelperToolGateway({
      context: helperContext(),
      handlers: {
        query_schedule: async () => {
          throw new Error("handler secret");
        }
      },
      authorize: async () => true
    });

    await expect(
      authorizationFailure.execute("query_schedule", { query: "查服事表" }, "official")
    ).resolves.toEqual(unavailable);
    await expect(
      handlerFailure.execute("query_schedule", { query: "查服事表" }, "official")
    ).resolves.toEqual(unavailable);
  });

  it("returns unavailable when a handler exceeds the tool deadline", async () => {
    const gateway = createHelperToolGateway({
      context: helperContext(),
      handlers: { query_schedule: () => new Promise(() => undefined) },
      timeoutMs: 1
    });

    await expect(
      gateway.execute("query_schedule", { query: "查服事表" }, "official")
    ).resolves.toEqual({ status: "unavailable", sourceType: "official" });
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
            fields: {
              sourceId: "source-1",
              sourceKey: "source-key",
              sourceIds: ["source-2"],
              documentKey: "document-key",
              sectionKey: "section-key",
              meeting: "主日"
            },
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
    expect(JSON.stringify(projected)).not.toMatch(
      /source-1|source-2|source-key|document-|section-key/u
    );
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(2_000);
  });

  it("drops URL-like reply-data kinds", () => {
    const projected = projectToolResult(
      {
        ok: true,
        replyText: "safe",
        agentResult: {
          status: "success",
          replyText: "safe",
          replyData: { kind: "https://temporary.example/private", fields: { meeting: "主日" } }
        }
      },
      "public"
    );

    expect(projected).toEqual({ status: "success", sourceType: "public" });
  });
});
