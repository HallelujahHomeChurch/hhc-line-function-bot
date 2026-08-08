import { describe, expect, it } from "vitest";

import type { EffectiveAccessContext } from "../application/access/effective-access.js";
import { projectEffectiveCapabilities } from "../application/capabilities/effective-capability-projection.js";
import {
  renderCapabilityHelp,
  renderRegistrationCompletion
} from "../application/capabilities/capability-presenters.js";
import type { FunctionExecutionResult } from "../application/contracts/function-execution.js";
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

    expect(projection).toEqual({
      reads: [],
      writes: [],
      onboarding: [],
      accountLoginAvailable: true
    });
  });

  it("never presents capabilities to an unauthorized requester", () => {
    const projection = projectEffectiveCapabilities({
      context: context({
        authorized: false,
        enabledFunctions: ["query_schedule", "save_memory"]
      })
    });

    expect(projection).toEqual({
      reads: [],
      writes: [],
      onboarding: [],
      accountLoginAvailable: true
    });
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
    expect(help.quickReplies).toEqual([expect.objectContaining({ label: "登入 HHC 帳戶" })]);
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

  it("keeps direct-only account login out of group presentation", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ sourceType: "group", enabledFunctions: ["query_schedule"] })
    });
    const help = renderCapabilityHelp(projection, "help");

    expect(help.replyText).not.toContain("登入 HHC 帳戶");
    expect(help.quickReplies?.map(({ label }) => label)).toEqual(["查服事表"]);
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

  it("renders complete ordinary capability copy without implementation details", () => {
    const projection = projectEffectiveCapabilities({
      context: context({ enabledFunctions: [...FUNCTION_NAMES] })
    });
    const help = renderCapabilityHelp(projection, "help");
    const introduction = renderCapabilityHelp(projection, "introduction");
    const registration = renderRegistrationCompletion(projection);

    expect(help.replyText).toContain("- 查服事表：依日期、聚會或服事類型查詢目前可用的服事安排。");
    expect(help.replyText).toContain("- 記住資訊：保存使用者明確請我記住的文字資訊。");
    expect(help.replyText).toContain("- 查教會資料：搜尋目前可用的泛用教會資料。");
    expect(help.replyText).toContain("- 保存檔案：");
    expect(help.replyText).toMatch(/上傳.*掃毒.*發布/u);
    expect(introduction.replyText).toMatch(/^我是小哈，家教會的小幫手。/u);
    expect(introduction.quickReplies).toEqual(help.quickReplies);
    expect(registration.replyText).toContain("小哈 下一場服事表");
    expect(registration.replyText).toContain("小哈 查歌譜 Yesterday");
    expect(registration.replyText).toContain("小哈 查投影片 奇異恩典");

    expectOrdinaryCopyToExcludeInternalTerms(help);
    expectOrdinaryCopyToExcludeInternalTerms(introduction);
    expectOrdinaryCopyToExcludeInternalTerms(registration);
  });

  it("renders provider-free main help from its profile identity, Weekly Paper, and public login only", () => {
    const mainProfile = {
      ...context({ enabledFunctions: ["download_weekly_paper"] }).profile,
      name: "main",
      identityLine: "我是 HHC 家教會小幫手。",
      allowedProviders: []
    } as BotProfileConfig;
    const projection = projectEffectiveCapabilities({
      context: {
        ...context({ enabledFunctions: ["download_weekly_paper"] }),
        profile: mainProfile
      }
    });

    const help = renderCapabilityHelp(projection, "help", mainProfile);
    const introduction = renderCapabilityHelp(projection, "introduction", mainProfile);

    expect(introduction.replyText).toMatch(/^我是 HHC 家教會小幫手。/u);
    expect(help.replyText).toContain("- 下載週報：");
    expect(help.replyText).toContain("- 登入 HHC 帳戶：");
    expect(help.replyText).not.toMatch(/registry|whoami|memories|forget-memory/iu);
    expect(help.replyText).not.toMatch(/查服事表|記住資訊|admin/iu);
    expect(help.quickReplies).toEqual([
      expect.objectContaining({ label: "下載週報" }),
      {
        label: "登入 HHC 帳戶",
        action: { type: "message", label: "登入 HHC 帳戶", text: "登入 HHC 帳戶" }
      }
    ]);
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

const ordinaryCopyForbiddenTerms =
  /OneDrive|Notion|Graph|DeepSeek|provider|storage|database|資料庫|儲存|儲存空間|雲端儲存|供應商|服務提供者|內部實作|資料來源|來源 ID|function name|功能名稱|user ID|使用者 ID|group ID|群組 ID/iu;

function expectOrdinaryCopyToExcludeInternalTerms(result: FunctionExecutionResult): void {
  const quickReplyCopy = (result.quickReplies ?? []).flatMap((quickReply) => [
    quickReply.label,
    quickReply.action.label,
    ...(quickReply.action.type === "message"
      ? [quickReply.action.text]
      : quickReply.action.displayText
        ? [quickReply.action.displayText]
        : [])
  ]);

  expect([result.replyText, ...quickReplyCopy].join("\n")).not.toMatch(ordinaryCopyForbiddenTerms);
}
