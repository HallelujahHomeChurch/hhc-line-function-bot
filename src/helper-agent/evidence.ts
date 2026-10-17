import { getFunctionDefinition } from "../capabilities/catalog.js";
import { isTaskShapedText } from "../agent/knowledge-evidence-guard.js";
import type { BotProfileConfig } from "../types.js";
import type { BaseMessage } from "langchain";

export function requiresFreshEvidence(
  profile: BotProfileConfig,
  text: string,
  history: BaseMessage[]
): boolean {
  if (isTaskShapedText(text)) return true;
  const question = /[?？]|嗎|呢|誰|哪|幾|是否|有沒有|還是|如何|怎麼|查詢|搜尋|顯示|列出/u.test(
    text
  );
  if (!question) return false;
  if (/完成|進度|處理|保存|上傳|同步|草稿|附件|照片/u.test(text)) return true;
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const hints = profile.enabledFunctions.flatMap((name) => {
    const definition = getFunctionDefinition(name);
    return definition?.sideEffectLevel === "read"
      ? [
          ...(definition.agentCapability?.intents ?? []),
          ...(definition.agentCapability?.retrievalEvidence?.queryStopWords ?? [])
        ]
      : [];
  });
  if (hints.some((hint) => hint.length >= 2 && normalized.includes(hint.toLocaleLowerCase())))
    return true;
  // A current-state follow-up cannot promote an earlier tool result into fresh evidence.
  return (
    history.some((message) => message.getType() === "tool") &&
    /現在|目前|剛剛|還是|仍然|那份|那個|這份|這個|他|她|它|第[一二三四五六七八九十\d]+|另一/u.test(
      text
    )
  );
}
