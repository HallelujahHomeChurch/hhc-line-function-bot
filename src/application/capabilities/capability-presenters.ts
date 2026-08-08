import type { FunctionExecutionResult, QuickReplyItem } from "../contracts/function-execution.js";
import type { BotProfileConfig } from "../../types.js";
import type {
  CapabilityPresentation,
  EffectiveCapabilityProjection
} from "./effective-capability-projection.js";

export function renderCapabilityHelp(
  projection: EffectiveCapabilityProjection,
  mode: "help" | "introduction",
  profile?: Pick<BotProfileConfig, "identityLine" | "allowedProviders">
): FunctionExecutionResult {
  const identityLine = profile?.identityLine ?? "我是小哈，家教會的小幫手。";
  const heading =
    mode === "introduction" ? [identityLine, "", "我目前可以協助："] : ["我目前可以協助："];
  const sections = [
    ...capabilitySections(projection),
    ...(projection.accountLoginAvailable ? ["帳戶\n- 登入 HHC 帳戶：連結你的 HHC 帳戶。"] : [])
  ];
  const providerFree = profile?.allowedProviders?.length === 0;
  const commandSection =
    mode === "help" && !providerFree
      ? [
          "",
          "常用指令",
          "- /registry <code>：使用邀請碼開通",
          "- /whoami：查看目前身分與來源",
          "- /memories：查看已保存的文字記憶",
          "- /forget-memory <id>：刪除指定的文字記憶"
        ]
      : [];

  return {
    ok: true,
    replyText: [
      ...heading,
      "",
      ...(sections.length > 0 ? sections : ["目前還沒有開放可使用的項目。"]),
      ...commandSection
    ].join("\n"),
    quickReplies: helpQuickReplies(projection)
  };
}

function helpQuickReplies(projection: EffectiveCapabilityProjection): QuickReplyItem[] {
  const capabilityReplies = projection.onboarding.map((presentation) => presentation.quickReply);
  if (!projection.accountLoginAvailable) return capabilityReplies.slice(0, 3);
  const loginReply: QuickReplyItem = {
    label: "登入 HHC 帳戶",
    action: { type: "message", label: "登入 HHC 帳戶", text: "登入 HHC 帳戶" }
  };
  return [...capabilityReplies.slice(0, 2), loginReply];
}

export function renderRegistrationCompletion(
  projection: EffectiveCapabilityProjection
): FunctionExecutionResult {
  const examples = projection.onboarding.map((presentation) => `- ${presentation.example}`);

  return {
    ok: true,
    replyText:
      examples.length > 0
        ? ["已開通，你現在可以使用小哈。", "", "可以先試試：", ...examples].join("\n")
        : ["已開通，你現在可以使用小哈。", "", "目前還沒有開放可查詢的項目。"].join("\n"),
    quickReplies: projection.onboarding.map((presentation) => presentation.quickReply).slice(0, 3)
  };
}

function capabilitySections(projection: EffectiveCapabilityProjection): string[] {
  return [
    formatSection("可以查詢", projection.reads),
    formatSection("可以保存或更新", projection.writes)
  ].filter((section): section is string => Boolean(section));
}

function formatSection(title: string, capabilities: CapabilityPresentation[]): string | undefined {
  if (capabilities.length === 0) return undefined;
  return [title, ...capabilities.map(formatCapability)].join("\n");
}

function formatCapability(capability: CapabilityPresentation): string {
  return `- ${capability.displayName}：${capability.shortDescription}`;
}
