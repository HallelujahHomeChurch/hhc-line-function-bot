import type { FunctionDefinition } from "../functions/definitions.js";

const LEADING_REQUEST_PHRASES = [
  "我想查詢",
  "我想查",
  "我想找",
  "請幫我查詢",
  "請幫我查",
  "請幫我找",
  "麻煩幫我查詢",
  "麻煩幫我查",
  "麻煩幫我找",
  "幫我查詢",
  "幫我查",
  "幫我找",
  "查詢",
  "搜尋",
  "查",
  "找"
];

export function projectRetrievalQuery(input: {
  text: string;
  definition: FunctionDefinition;
}): string {
  let projected = input.text
    .normalize("NFKC")
    .trim()
    .replace(/^小哈[\s,，、:：。.!！?？]*/u, "")
    .trim();

  for (let pass = 0; pass < 4; pass += 1) {
    const before = projected;
    const prefix = LEADING_REQUEST_PHRASES.find((phrase) => projected.startsWith(phrase));
    if (prefix) projected = projected.slice(prefix.length).trim();
    if (projected === before) break;
  }

  const stopWords = new Set([
    ...(input.definition.agentCapability?.retrievalEvidence?.queryStopWords ?? []),
    ...input.definition.requiredSlots.flatMap((slot) => slot.genericRequest?.phrases ?? [])
  ]);
  for (const stopWord of [...stopWords].sort((left, right) => right.length - left.length)) {
    if (!stopWord.trim()) continue;
    projected = projected.replaceAll(stopWord.normalize("NFKC"), " ");
  }

  return projected
    .replace(/(^|\s)的(?=\s|$)/gu, " ")
    .replace(/的\s*$/u, "")
    .replace(/[，,。.!！?？:：、]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
