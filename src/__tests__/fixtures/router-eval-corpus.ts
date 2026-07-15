import type { FunctionName } from "../../types.js";
import { getRouterEvalCases, type RouterEvalCase } from "../../functions/modules.js";

export const routerEvalEnabledFunctions: FunctionName[] = [
  "find_ppt_slides",
  "query_schedule",
  "query_knowledge",
  "save_schedule",
  "find_sheet_music",
  "find_resource",
  "query_wikipedia",
  "save_memory",
  "save_resource",
  "retrieve_memory"
];

export const keywordRouteEvalCases: RouterEvalCase[] = getRouterEvalCases();

export const keywordDenyEvalCases: RouterEvalCase[] = [
  ...getRouterEvalCases().filter((entry) => entry.expected.type === "deny"),
  "小哈 查流行歌 Yesterday",
  "小哈 查詩歌 奇異恩典",
  "小哈 幫我查資料"
].map((entry) =>
  typeof entry === "string"
    ? {
        kind: "negative",
        text: entry,
        expected: { type: "deny", reason: "keyword_no_match" }
      }
    : entry
);
