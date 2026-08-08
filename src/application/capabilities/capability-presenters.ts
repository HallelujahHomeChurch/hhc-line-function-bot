import type { FunctionExecutionResult, QuickReplyItem } from "../contracts/function-execution.js";
import type { BotProfileConfig } from "../../types.js";
import type {
  CapabilityPresentation,
  EffectiveCapabilityProjection
} from "./effective-capability-projection.js";

export function renderCapabilityHelp(
  projection: EffectiveCapabilityProjection,
  mode: "help" | "introduction",
  profile?: Pick<BotProfileConfig, "identityLine" | "allowedProviders">,
  account?: AccountSurfacePresentation
): FunctionExecutionResult {
  const identityLine = profile?.identityLine ?? "我是小哈，家教會的小幫手。";
  const heading =
    mode === "introduction" ? [identityLine, "", "我目前可以協助："] : ["我目前可以協助："];
  const accountSection = renderHelpAccountSection(projection, account);
  const sections = [...capabilitySections(projection), ...(accountSection ? [accountSection] : [])];
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
    quickReplies: helpQuickReplies(projection, account)
  };
}

export interface AccountSurfacePresentation {
  status: "disabled" | "unbound" | "active" | "inactive" | "unavailable";
  account?: {
    displayName: string;
    maskedEmail: string;
    roles: Array<"user" | "admin">;
  };
}

export function renderAccountIdentity(
  account: AccountSurfacePresentation,
  allowedProjection: EffectiveCapabilityProjection
): FunctionExecutionResult {
  if (account.status === "disabled") {
    return { ok: true, replyText: "這個 bot 目前沒有開放 HHC 帳戶登入。" };
  }
  if (account.status === "unavailable") {
    return { ok: true, replyText: "目前無法確認帳戶狀態，請稍後再試。" };
  }
  if (account.status === "inactive") {
    return { ok: true, replyText: "你的 HHC 帳戶目前無法使用，請聯絡管理同工協助。" };
  }
  if (account.status === "unbound" || !account.account) {
    return {
      ok: true,
      replyText: "你尚未連結 HHC 帳戶。\n傳送「登入」開始連結。",
      quickReplies: [accountLoginQuickReply()]
    };
  }
  const functionNames = [...allowedProjection.reads, ...allowedProjection.writes].map(
    ({ displayName }) => `- ${displayName}`
  );
  return {
    ok: true,
    replyText: [
      "HHC 帳戶",
      `名稱：${account.account.displayName}`,
      `Email：${account.account.maskedEmail}`,
      `身分：${account.account.roles.join("、")}`,
      ...(functionNames.length > 0 ? ["", "已授權功能", ...functionNames] : [])
    ].join("\n")
  };
}

function renderHelpAccountSection(
  projection: EffectiveCapabilityProjection,
  account: AccountSurfacePresentation | undefined
): string | undefined {
  if (!account) {
    return projection.accountLoginAvailable
      ? "帳戶\n- 登入 HHC 帳戶：連結你的 HHC 帳戶。"
      : undefined;
  }
  if (account.status === "unbound" && projection.accountLoginAvailable) {
    return "帳戶\n- 登入 HHC 帳戶：連結你的 HHC 帳戶。";
  }
  if (account.status === "active" && account.account) {
    return `帳戶\n- 已連結 ${account.account.displayName}（${account.account.maskedEmail}）`;
  }
  if (account.status === "inactive") {
    return "帳戶\n- HHC 帳戶目前無法使用，請聯絡管理同工協助。";
  }
  if (account.status === "unavailable") {
    return "帳戶\n- 目前無法確認帳戶狀態，請稍後再試。";
  }
  return undefined;
}

function helpQuickReplies(
  projection: EffectiveCapabilityProjection,
  account?: AccountSurfacePresentation
): QuickReplyItem[] {
  const capabilityReplies = projection.onboarding.map((presentation) => presentation.quickReply);
  if (!projection.accountLoginAvailable || (account && account.status !== "unbound"))
    return capabilityReplies.slice(0, 3);
  return [...capabilityReplies.slice(0, 2), accountLoginQuickReply()];
}

function accountLoginQuickReply(): QuickReplyItem {
  return {
    label: "登入 HHC 帳戶",
    action: { type: "message", label: "登入 HHC 帳戶", text: "登入 HHC 帳戶" }
  };
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
