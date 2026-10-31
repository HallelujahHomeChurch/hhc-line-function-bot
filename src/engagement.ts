import { introVariantForText } from "./intro.js";
import type { BotProfileConfig, LineMessage, SmallTalkCategory } from "./types.js";

export type GroupEngagementKind =
  "command" | "small_talk" | "intro" | "mention_only" | "third_person" | "ignore";

export interface GroupEngagement {
  kind: GroupEngagementKind;
  smallTalkCategory?: SmallTalkCategory;
}

// Require a vocative boundary; a name embedded in commentary is not an invocation.
const addressContinuationPattern =
  /^(?:[\s,，、:：!！?？]|幫|帮|請|请|查|找|你好|你會|你能|謝謝|辛苦)/u;

export function classifyGroupEngagement(
  profile: BotProfileConfig,
  message?: LineMessage
): GroupEngagement {
  if (message?.type !== "text") {
    return { kind: "ignore" };
  }
  const text = normalizeText(message.text ?? "");
  if (!text) {
    return { kind: "ignore" };
  }

  if (!profile.groupRequireWakeWord) {
    return classifyAddressedText(text);
  }

  const addressedText = explicitAddressedText(profile, message);
  if (addressedText === undefined) {
    return profile.wakeKeywords.some((keyword) => text.includes(keyword))
      ? { kind: "third_person" }
      : { kind: "ignore" };
  }

  if (!addressedText) {
    return { kind: "intro" };
  }
  return classifyAddressedText(addressedText);
}

export function groupEngagementAllowsReply(engagement: GroupEngagement): boolean {
  return (
    engagement.kind === "command" || engagement.kind === "intro" || engagement.kind === "small_talk"
  );
}

export function groupEngagementIgnoredReason(engagement: GroupEngagement): string {
  if (engagement.kind === "third_person" || engagement.kind === "mention_only") {
    return "group_not_addressed";
  }
  return "wake_word_missing";
}

function classifyAddressedText(text: string): GroupEngagement {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { kind: "intro" };
  }
  if (introVariantForText(normalized)) {
    return { kind: "intro" };
  }
  const smallTalkCategory = classifySmallTalkCategory(normalized);
  if (smallTalkCategory) {
    return { kind: "small_talk", smallTalkCategory };
  }
  return { kind: "command" };
}

export function explicitAddressedText(
  profile: BotProfileConfig,
  message?: LineMessage
): string | undefined {
  if (message?.type !== "text") return undefined;
  let text = normalizeText(message.text ?? "");
  const selfMention = Boolean(
    profile.acceptMention && message.mention?.mentionees?.some((m) => m.isSelf)
  );
  const keywords = profile.wakeKeywords.filter((keyword) => keyword.trim());
  const afterGreeting = text.replace(/^(?:hi|hello|hey|嗨|哈囉|你好)[\s,，、!！]+/iu, "");
  if (keywords.some((keyword) => startsWithAddress(afterGreeting, keyword))) text = afterGreeting;
  if (!selfMention && !keywords.some((keyword) => startsWithAddress(text, keyword)))
    return undefined;
  return stripAddress(text, keywords, selfMention);
}

function startsWithAddress(text: string, keyword: string): boolean {
  if (!text.startsWith(keyword)) {
    return false;
  }
  const rest = text.slice(keyword.length);
  return (
    rest.length === 0 ||
    addressContinuationPattern.test(rest) ||
    introVariantForText(rest) !== undefined
  );
}

function stripAddress(text: string, wakeKeywords: string[], selfMention: boolean): string {
  let result = text;
  for (const keyword of wakeKeywords) {
    if (startsWithAddress(result, keyword)) {
      result = result.slice(keyword.length);
      break;
    }
  }
  if (selfMention) {
    result = result.replace(/^@\S+\s*/u, "");
  }
  return result.replace(/^[\s,，、:：。.!！?？]+/u, "").trim();
}

export function classifySmallTalkCategory(text: string): SmallTalkCategory | undefined {
  const lower = normalizeText(text).toLowerCase();
  if (/你好嗎|還在嗎|在嗎|最近好嗎|好嗎|安好/u.test(lower)) {
    return "wellbeing";
  }
  if (/^(你好|哈囉|嗨|hi|hello|hey|早安|午安|晚安)$/iu.test(lower)) {
    return "greeting";
  }
  if (/謝謝|謝啦|感謝|thanks|thank you/u.test(lower)) {
    return "thanks";
  }
  if (/難為|為難|還好嗎|累嗎|累不累|辛苦嗎/u.test(lower)) {
    return "reassurance";
  }
  if (/人設|i人|e人|內向|外向|安靜/u.test(lower)) {
    return "persona";
  }
  if (/辛苦|加油|很棒|厲害|強/u.test(lower)) {
    return "encouragement";
  }
  if (/哈哈|好笑|開玩笑|笑死/u.test(lower)) {
    return "light_joke";
  }
  return undefined;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim();
}
