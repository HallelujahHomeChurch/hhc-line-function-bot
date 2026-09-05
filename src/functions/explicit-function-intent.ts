import type { CapabilityName } from "../capabilities/names.js";
import { getFunctionDefinition } from "../capabilities/catalog.js";

export function isExplicitFunctionSwitch(
  text: string,
  current: CapabilityName,
  enabledFunctions: readonly CapabilityName[]
): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  if (/(?:不要|不用|取消|先不要)/u.test(normalized)) return false;
  return enabledFunctions.some((name) => {
    if (name === current) return false;
    const intents = getFunctionDefinition(name)?.agentCapability?.intents ?? [];
    return intents.some((intent) => normalized.includes(intent.normalize("NFKC").toLowerCase()));
  });
}

export function matchExactWholeMessageIntent(
  text: string,
  intents: readonly string[]
): string | undefined {
  const normalized = normalizeExact(text);
  if (/(?:不要|不用|取消|先不要)/u.test(normalized)) return undefined;
  return intents.find((intent) => normalized === normalizeExact(intent));
}

function normalizeExact(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/[!！。.?？]+$/gu, "")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-TW");
}
