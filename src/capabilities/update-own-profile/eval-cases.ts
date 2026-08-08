import type { RouterEvalCase } from "../../application/contracts/function-module.js";
import { FUNCTION_NAMES } from "../../types.js";

export const updateOwnProfileRouterEvalCases: RouterEvalCase[] = [
  {
    kind: "positive",
    text: "/profile",
    expected: { type: "execute", action: "update_own_profile", arguments: {} }
  },
  {
    kind: "missing_slot",
    text: "修改姓名",
    expected: { type: "execute", action: "update_own_profile", arguments: {} }
  },
  {
    kind: "typo",
    text: "修改明稱",
    expected: { type: "deny", reason: "keyword_no_match" }
  },
  {
    kind: "negative",
    text: "不要修改姓名",
    expected: { type: "deny", reason: "keyword_no_match" }
  },
  {
    kind: "disabled",
    text: "/profile",
    enabledFunctions: FUNCTION_NAMES.filter((name) => name !== "update_own_profile"),
    expected: { type: "deny", reason: "function_disabled" }
  },
  {
    kind: "cross_function",
    text: "下載最新週報",
    expected: { type: "execute", action: "download_weekly_paper", arguments: {} }
  }
];
