import { renderCapabilityHelp } from "./application/capabilities/capability-presenters.js";
import type { EffectiveCapabilityProjection } from "./application/capabilities/effective-capability-projection.js";
import type { FunctionExecutionResult } from "./types.js";

type IntroVariant = "identity" | "capabilities";

interface IntroReplyOptions {
  force?: boolean;
  variant?: IntroVariant;
}

const identityTriggers = ["小哈", "小哈?", "小哈？", "小哈是誰", "小哈你是誰"];

const capabilitiesTriggers = [
  "help",
  "功能",
  "使用說明",
  "小哈可以幹嘛",
  "小哈可以做什麼",
  "小哈你能做什麼",
  "小哈你會什麼",
  "小哈會什麼",
  "你可以做什麼",
  "你能做什麼",
  "你會什麼",
  "能做什麼"
];

export function createIntroReply(
  projection: EffectiveCapabilityProjection,
  rawText: string,
  options: IntroReplyOptions = {}
): FunctionExecutionResult | undefined {
  const normalized = normalizeIntroText(rawText);
  const addressed = stripWakeAddress(normalized);
  const variant = options.variant ?? introVariantFor(normalized) ?? introVariantFor(addressed);
  if (!options.force && !variant) {
    return undefined;
  }

  const selectedVariant = variant ?? "identity";
  if (selectedVariant === "identity") {
    return { ok: true, replyText: "我是小哈，家教會的小幫手。" };
  }
  return renderCapabilityHelp(projection, "introduction");
}

function introVariantFor(normalized: string): IntroVariant | undefined {
  if (identityTriggers.includes(normalized)) {
    return "identity";
  }
  if (capabilitiesTriggers.includes(normalized)) {
    return "capabilities";
  }
  return undefined;
}

function normalizeIntroText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[!！。.?？\s]+$/g, "")
    .toLowerCase();
}

function stripWakeAddress(value: string): string {
  if (!value.startsWith("小哈")) {
    return value;
  }
  return value.slice("小哈".length).replace(/^[，,、:：?？\s]+/u, "");
}
