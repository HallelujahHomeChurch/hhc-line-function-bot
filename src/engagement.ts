import type { BotProfileConfig, LineMessage, SmallTalkCategory } from "./types.js";

export type GroupEngagementKind =
  "command" | "small_talk" | "intro" | "mention_only" | "third_person" | "ignore";

export interface GroupEngagement {
  kind: GroupEngagementKind;
  smallTalkCategory?: SmallTalkCategory;
}

const addressContinuationPattern =
  /^[\s,，、:：。.!！?？]|^[查找幫帮請请可你會会人謝谢辛投服流樂乐歌要給给]/u;

const commandHints = [
  "查",
  "找",
  "搜尋",
  "投影片",
  "ppt",
  "簡報",
  "服事",
  "服事表",
  "聚會",
  "流行",
  "樂譜",
  "歌譜",
  "sheet",
  "music",
  "下一場",
  "今天",
  "明天",
  "主日"
];

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

  const selfMention = Boolean(
    profile.acceptMention && message.mention?.mentionees?.some((mentionee) => mentionee.isSelf)
  );
  const wakeKeywords = profile.wakeKeywords.filter((keyword) => keyword.trim());
  const startsWithWake = wakeKeywords.some((keyword) => startsWithAddress(text, keyword));
  const containsWake = wakeKeywords.some((keyword) => text.includes(keyword));

  if (!selfMention && !startsWithWake) {
    return containsWake ? { kind: "third_person" } : { kind: "ignore" };
  }

  const addressedText = stripAddress(text, wakeKeywords, selfMention);
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
  if (isIntroText(normalized)) {
    return { kind: "intro" };
  }
  const smallTalkCategory = classifySmallTalkCategory(normalized);
  if (smallTalkCategory) {
    return { kind: "small_talk", smallTalkCategory };
  }
  if (commandHints.some((hint) => normalized.toLowerCase().includes(hint.toLowerCase()))) {
    return { kind: "command" };
  }
  return { kind: "command" };
}

function startsWithAddress(text: string, keyword: string): boolean {
  if (!text.startsWith(keyword)) {
    return false;
  }
  const rest = text.slice(keyword.length);
  return rest.length === 0 || addressContinuationPattern.test(rest);
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

function isIntroText(text: string): boolean {
  const value = text.replace(/[!！。.\s]+$/gu, "").toLowerCase();
  return [
    "小哈",
    "help",
    "功能",
    "使用說明",
    "可以幹嘛",
    "可以做什麼",
    "你會什麼",
    "會什麼",
    "小哈可以幹嘛",
    "小哈可以做什麼",
    "小哈你會什麼",
    "小哈會什麼"
  ].includes(value);
}

function classifySmallTalkCategory(text: string): SmallTalkCategory | undefined {
  const lower = text.toLowerCase();
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
