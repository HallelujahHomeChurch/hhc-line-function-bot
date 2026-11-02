import type { FunctionExecutionResult } from "../types.js";
import type { QuoteReplyProjection } from "./types.js";

export function deliveredContextText(
  text: string,
  projection?: QuoteReplyProjection
): string | null {
  if (projection?.contextPolicy === "status_only")
    return "公開搜尋已結束；原文不在對話上下文內，需以仍有效的結果編號重新預覽。";
  if (projection?.history) return null;
  if (projection?.kind === "preview") return "已顯示待確認預覽，尚未保存；修改時須讀取目前草稿。";
  const redacted = text.replace(/https?:\/\/[^\s<>]+/giu, "[連結省略]");
  const safe = safeQuoteText(redacted);
  return safe && redacted.length > 1000 ? `[回覆節錄，並非完整內容] ${safe.slice(0, 975)}` : safe;
}

export function replyProjection(result: FunctionExecutionResult): QuoteReplyProjection {
  return {
    ...(result.contextPolicy ? { contextPolicy: result.contextPolicy } : {}),
    ...(result.historyDependencies !== undefined
      ? { history: true as const, historyDependencies: result.historyDependencies }
      : {}),
    kind: result.writePhase ?? (result.contextReference ? "read" : "conversation"),
    ...(result.contextReference ? { publicRead: result.contextReference } : {})
  };
}

export function safeQuoteText(value: string): string | null {
  // Credential links, commands and approval drafts are reference-only. Never retain their secrets.
  if (
    /https?:\/\/|(?:^|\s)\/[a-z]|(?:token|nonce|secret|password|api\s*key|access\s*key|密碼|私鑰|金鑰|驗證碼|邀請碼|綁定碼|確認碼)\s*[:：=]?|action=|Bearer\s/iu.test(
      value
    )
  )
    return null;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return text ? text.slice(0, 1000) : null;
}
