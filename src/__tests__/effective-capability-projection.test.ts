import { describe, expect, it } from "vitest";

import type { EffectiveAccessContext } from "../application/access/effective-access.js";
import { projectEffectiveCapabilities } from "../application/capabilities/effective-capability-projection.js";
import {
  renderCapabilityHelp,
  renderRegistrationCompletion
} from "../application/capabilities/capability-presenters.js";
import { getFunctionDefinition, type FunctionDefinition } from "../functions/definitions.js";
import { FUNCTION_NAMES, type BotProfileConfig, type FunctionName } from "../types.js";

function context(
  input: {
    authorized?: boolean;
    sourceType?: EffectiveAccessContext["sourceType"];
    enabledFunctions?: FunctionName[];
  } = {}
): EffectiveAccessContext {
  return {
    profile: {
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
      enabledFunctions: input.enabledFunctions ?? [],
      adminUserId: "Uadmin",
      adminDirectOnly: true
    } as BotProfileConfig,
    authorized: input.authorized ?? true,
    requesterIsAdmin: false,
    sourceType: input.sourceType ?? "user"
  };
}

function definition(name: FunctionName, overrides: Partial<FunctionDefinition> = {}) {
  const value = getFunctionDefinition(name);
  if (!value) throw new Error(`Missing definition: ${name}`);
  return { ...value, ...overrides };
}

describe("effective capability projection", () => {
  it("ranks the preferred onboarding reads in their fixed order", () => {
    const projection = projectEffectiveCapabilities({
      context: context({
        enabledFunctions: ["find_ppt_slides", "find_sheet_music", "query_schedule"]
      })
    });

    expect(projection.onboarding.map((item) => item.functionName)).toEqual([
      "query_schedule",
      "find_sheet_music",
      "find_ppt_slides"
    ]);
  });

  it("uses canonical definition order for non-preferred onboarding reads", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ enabledFunctions: ["query_wikipedia", "find_resource"] })
    });

    expect(projection.onboarding.map((item) => item.functionName)).toEqual([
      "find_resource",
      "query_wikipedia"
    ]);
  });

  it("groups the complete effective capability set into reads and writes", () => {
    const projection = projectEffectiveCapabilities({
      context: context({
        enabledFunctions: ["save_memory", "find_resource", "save_schedule", "query_schedule"]
      })
    });

    expect(projection.reads.map((item) => item.functionName)).toEqual([
      "query_schedule",
      "find_resource"
    ]);
    expect(projection.writes.map((item) => item.functionName)).toEqual([
      "save_schedule",
      "save_memory"
    ]);
  });

  it("filters definitions that are not allowed in the current source", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ enabledFunctions: ["query_schedule"] }),
      definitions: [definition("query_schedule", { allowedSources: ["group"] })]
    });

    expect(projection).toEqual({ reads: [], writes: [], onboarding: [] });
  });

  it("never presents capabilities to an unauthorized requester", () => {
    const projection = projectEffectiveCapabilities({
      context: context({
        authorized: false,
        enabledFunctions: ["query_schedule", "save_memory"]
      })
    });

    expect(projection).toEqual({ reads: [], writes: [], onboarding: [] });
  });

  it("keeps administrator actions out of ordinary output", () => {
    const projection = projectEffectiveCapabilities({
      context: context({
        enabledFunctions: ["query_schedule", "save_memory"]
      }),
      definitions: [
        definition("query_schedule", { sideEffectLevel: "admin" }),
        definition("save_memory")
      ]
    });
    const help = renderCapabilityHelp(projection, "help");

    expect(help.replyText).not.toContain("查服事表");
    expect(help.replyText).toContain("記住資訊");
    expect(help.quickReplies).toEqual([]);
  });

  it("caps onboarding and every ordinary presenter at three quick replies", () => {
    const projection = projectEffectiveCapabilities({
      context: context({
        enabledFunctions: [
          "find_ppt_slides",
          "query_schedule",
          "query_knowledge",
          "find_sheet_music",
          "find_resource",
          "query_wikipedia",
          "retrieve_memory"
        ]
      })
    });

    expect(projection.onboarding).toHaveLength(3);
    expect(renderCapabilityHelp(projection, "help").quickReplies).toHaveLength(3);
    expect(renderCapabilityHelp(projection, "introduction").quickReplies).toHaveLength(3);
    expect(renderRegistrationCompletion(projection).quickReplies).toHaveLength(3);
  });

  it("uses bounded labels and the first definition example for message quick replies", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ enabledFunctions: ["query_schedule"] }),
      definitions: [
        definition("query_schedule", {
          displayName: "這是一個名稱超過二十個字元的查詢功能請立刻使用",
          examples: ["小哈 下一場服事表"]
        })
      ]
    });

    expect(projection.onboarding[0]?.quickReply).toEqual({
      label: "這是一個名稱超過二十個字元的查詢功能請立",
      action: {
        type: "message",
        label: "這是一個名稱超過二十個字元的查詢功能請立",
        text: "小哈 下一場服事表"
      }
    });
  });

  it("bounds message quick reply text to LINE's 300-character limit", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ enabledFunctions: ["query_schedule"] }),
      definitions: [definition("query_schedule", { examples: ["x".repeat(301)] })]
    });

    const action = projection.onboarding[0]?.quickReply.action;
    expect(action).toMatchObject({ type: "message" });
    expect(action?.type === "message" ? action.text.length : 0).toBe(300);
  });

  it("renders complete help and introduction without implementation details", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ enabledFunctions: [...FUNCTION_NAMES] })
    });
    const help = renderCapabilityHelp(projection, "help");
    const introduction = renderCapabilityHelp(projection, "introduction");

    expect(help.replyText).toContain("- 查服事表：依日期、聚會或服事類型查詢目前可用的服事安排。");
    expect(help.replyText).toContain("- 記住資訊：保存使用者明確請我記住的文字資訊。");
    expect(help.replyText).toContain("- 查教會資料：搜尋目前可用的泛用教會資料。");
    expect(introduction.replyText).toMatch(/^我是小哈，家教會的小幫手。/u);
    expect(introduction.quickReplies).toEqual(help.quickReplies);
    expect(`${help.replyText}\n${introduction.replyText}`).not.toMatch(
      /OneDrive|Notion|Graph|DeepSeek|provider|storage|database|資料庫|資料來源|來源 ID|function name|功能名稱|user ID|使用者 ID|group ID|群組 ID/iu
    );
  });

  it("uses only onboarding items for registration completion without identifiers", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ enabledFunctions: ["query_schedule", "save_memory"] })
    });
    const registration = renderRegistrationCompletion(projection);

    expect(registration.replyText).toContain("已開通，你現在可以使用小哈。");
    expect(registration.replyText).toContain("小哈 下一場服事表");
    expect(registration.replyText).not.toContain("記住資訊");
    expect(registration.replyText).not.toMatch(/Uadmin|group ID|user ID/iu);
  });
});
