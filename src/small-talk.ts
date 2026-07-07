import { SMALL_TALK_CATEGORIES } from "./types.js";
import type { FunctionExecutionResult, JsonRecord, SmallTalkCategory } from "./types.js";

const replies: Record<SmallTalkCategory, string> = {
  thanks: "不客氣，有需要再叫我。",
  encouragement: "不辛苦，我在旁邊幫忙就好。",
  reassurance: "不會啦，我比較適合安靜地幫忙查資料。有明確歌名或聚會範圍時，我會比較快幫上忙。",
  persona: "有一點像，我比較適合安靜地把資料找好。",
  light_joke: "我可以安靜幫忙，但不要太考驗我。"
};

export function createSmallTalkReply(category: SmallTalkCategory): FunctionExecutionResult {
  return {
    ok: true,
    replyText: replies[category]
  };
}

export function smallTalkCategoryFromArguments(args: JsonRecord): SmallTalkCategory {
  const raw = typeof args.category === "string" ? args.category.trim() : "";
  return isSmallTalkCategory(raw) ? raw : "reassurance";
}

export function isSmallTalkCategory(value: string): value is SmallTalkCategory {
  return (SMALL_TALK_CATEGORIES as readonly string[]).includes(value);
}
