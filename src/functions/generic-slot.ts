import type { FunctionRequiredSlot } from "./definitions.js";
import type { JsonRecord } from "../types.js";

const requestPrefixes = [
  "請幫我",
  "幫我",
  "麻煩",
  "我想要",
  "我要",
  "我想",
  "小哈",
  "查詢",
  "搜尋",
  "lookup",
  "search",
  "find",
  "showme",
  "請",
  "想要",
  "想",
  "查",
  "找",
  "看",
  "給我",
  "一份",
  "一首",
  "一個",
  "一些"
];

export function findGenericRequestSlot(
  slots: FunctionRequiredSlot[],
  text: string
): FunctionRequiredSlot | undefined {
  return slots.find(
    (slot) =>
      slot.genericRequest &&
      slot.genericRequest.phrases.some(
        (phrase) => normalizeGenericRequestText(text) === normalizeGenericRequestText(phrase)
      )
  );
}

export function isGenericSlotValue(slot: FunctionRequiredSlot, args: JsonRecord): boolean {
  if (!slot.genericRequest || hasStructuredArgument(slot, args)) {
    return false;
  }
  const value = stringArgument(args, slot.argument);
  if (!value) {
    return false;
  }
  return slot.genericRequest.phrases.some(
    (phrase) => normalizeGenericRequestText(value) === normalizeGenericRequestText(phrase)
  );
}

export function clearGenericSlotArguments(
  slot: FunctionRequiredSlot,
  args: JsonRecord
): JsonRecord {
  const next = { ...args, [slot.argument]: "" };
  for (const argument of slot.genericRequest?.clearArguments ?? []) {
    delete next[argument];
  }
  return next;
}

function hasStructuredArgument(slot: FunctionRequiredSlot, args: JsonRecord): boolean {
  return (slot.genericRequest?.clearArguments ?? []).some((argument) =>
    Boolean(stringArgument(args, argument))
  );
}

function normalizeGenericRequestText(value: string): string {
  let normalized = value.normalize("NFKC").trim().toLocaleLowerCase();

  for (let index = 0; index < 6; index += 1) {
    const before = normalized;
    normalized = normalized.replace(/^[\s,，、:：。！？!?]+/u, "");
    const prefix = requestPrefixes.find((candidate) => normalized.startsWith(candidate));
    if (prefix) {
      normalized = normalized.slice(prefix.length);
    }
    if (normalized === before) {
      break;
    }
  }

  return normalized.replace(/[\s,，、:：。！？!?"'`~·…/\\|_-]+/gu, "");
}

function stringArgument(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
