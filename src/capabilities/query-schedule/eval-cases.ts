import { FUNCTION_NAMES } from "../../types.js";
import type { RouterEvalCase } from "../../functions/modules.js";

export const queryScheduleRouterEvalCases: RouterEvalCase[] = [
  {
    kind: "positive",
    text: "小哈 下一場聚會服事表",
    expected: {
      type: "execute",
      action: "query_schedule",
      arguments: { query: "下一場聚會服事表", dateIntent: "next_meeting" }
    }
  },
  {
    kind: "positive",
    text: "小哈 給我下一場影視團隊的服事表",
    expected: {
      type: "execute",
      action: "query_schedule",
      arguments: {
        query: "給我下一場影視團隊的服事表",
        dateIntent: "next_meeting"
      }
    }
  },
  {
    kind: "positive",
    text: "小哈 下一場服事表的音控是誰",
    expected: {
      type: "execute",
      action: "query_schedule",
      arguments: {
        query: "下一場服事表的音控是誰",
        dateIntent: "next_meeting"
      }
    }
  },
  {
    kind: "positive",
    text: "小哈 下一場青年出隊服事表",
    expected: {
      type: "execute",
      action: "query_schedule",
      arguments: {
        query: "下一場青年出隊服事表",
        dateIntent: "next_meeting"
      }
    }
  },
  {
    kind: "missing_slot",
    text: "小哈 查服事表",
    expected: {
      type: "execute",
      action: "query_schedule",
      arguments: { query: "" }
    }
  },
  {
    kind: "typo",
    text: "小哈 查7/19舉牌",
    expected: {
      type: "execute",
      action: "query_schedule",
      arguments: { query: "7/19舉牌", scheduleType: "street_sign_service" }
    }
  },
  {
    kind: "negative",
    text: "小哈 幫我訂便當",
    expected: { type: "deny", reason: "keyword_no_match" }
  },
  {
    kind: "disabled",
    text: "小哈 下一場聚會服事表",
    enabledFunctions: FUNCTION_NAMES.filter((name) => name !== "query_schedule"),
    expected: { type: "deny", reason: "function_disabled" }
  },
  {
    kind: "cross_function",
    text: "小哈 查投影片 主日報告",
    expected: {
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "主日報告", matchMode: "fuzzy" }
    }
  },
  {
    kind: "cross_function",
    text: "小哈 查流行歌譜 奇異恩典",
    expected: {
      type: "execute",
      action: "find_sheet_music",
      arguments: {
        query: "奇異恩典",
        fileType: "pdf",
        matchMode: "fuzzy"
      }
    }
  }
];
