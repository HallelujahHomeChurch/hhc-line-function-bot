import { getFunctionDefinitions } from "./functions/definitions.js";
import { buildFunctionQuickReplies } from "./line-reply.js";
import type { BotProfileConfig, FunctionExecutionResult } from "./types.js";

type IntroVariant = "identity" | "capabilities";

interface IntroReplyOptions {
  force?: boolean;
  variant?: IntroVariant;
  random?: () => number;
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
  profile: BotProfileConfig,
  rawText: string,
  options: IntroReplyOptions = {}
): FunctionExecutionResult | undefined {
  const normalized = normalizeIntroText(rawText);
  const addressed = stripWakeAddress(normalized);
  const variant = options.variant ?? introVariantFor(normalized) ?? introVariantFor(addressed);
  if (!options.force && !variant) {
    return undefined;
  }

  const definitions = getFunctionDefinitions(profile.enabledFunctions);
  const selectedVariant = variant ?? "identity";
  if (definitions.length === 0) {
    return {
      ok: true,
      replyText:
        selectedVariant === "capabilities"
          ? "目前還沒有開放可查詢的項目。"
          : "我是小哈，家教會小幫手。目前還沒有開放可查詢的項目。"
    };
  }

  const functionNames = definitions.map((definition) => definition.displayName).join("、");
  const lines =
    selectedVariant === "capabilities"
      ? [`我能：${functionNames}。`]
      : [`我是小哈，家教會小幫手。需要幫助時可以叫我一聲，我可以：${functionNames}。`];
  const examples = selectExamples(definitions, options.random ?? Math.random);

  return {
    ok: true,
    replyText: [...lines, "", "你可以試試：", ...examples.map((example) => `- ${example}`)]
      .filter((line) => line !== undefined)
      .join("\n"),
    quickReplies: buildFunctionQuickReplies(profile)
  };
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

function selectExamples(
  definitions: ReturnType<typeof getFunctionDefinitions>,
  random: () => number
): string[] {
  const selected = definitions.length <= 3 ? definitions : sample(definitions, 3, random);
  return selected.map((definition) => definition.examples[0] ?? definition.quickReply.command);
}

function sample<T>(values: T[], count: number, random: () => number): T[] {
  const remaining = [...values];
  const selected: T[] = [];
  while (selected.length < count && remaining.length > 0) {
    const index = Math.min(Math.floor(random() * remaining.length), remaining.length - 1);
    selected.push(remaining.splice(index, 1)[0]);
  }
  return selected;
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
