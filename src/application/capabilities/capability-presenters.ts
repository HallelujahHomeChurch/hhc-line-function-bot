import type { FunctionExecutionResult } from "../contracts/function-execution.js";
import type {
  CapabilityPresentation,
  EffectiveCapabilityProjection
} from "./effective-capability-projection.js";

export function renderCapabilityHelp(
  projection: EffectiveCapabilityProjection,
  mode: "help" | "introduction"
): FunctionExecutionResult {
  const heading =
    mode === "introduction"
      ? ["我是小哈，家教會的小幫手。", "", "我目前可以協助："]
      : ["我目前可以協助："];
  const sections = capabilitySections(projection);

  return {
    ok: true,
    replyText: [
      ...heading,
      "",
      ...(sections.length > 0 ? sections : ["目前還沒有開放可使用的項目。"])
    ].join("\n"),
    quickReplies: projection.onboarding.map((presentation) => presentation.quickReply).slice(0, 3)
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
