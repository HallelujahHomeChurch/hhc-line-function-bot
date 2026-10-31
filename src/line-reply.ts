import type { FunctionExecutionResult, QuickReplyItem } from "./types.js";

export function buildPostbackQuickReply(
  label: string,
  data: string,
  displayText = label
): QuickReplyItem {
  return {
    label,
    action: {
      type: "postback",
      label,
      data,
      displayText
    }
  };
}

/** LINE accepts at most five text messages of 5,000 UTF-16 units per reply. */
export function buildLineTextMessages(text: string, quickReplies: QuickReplyItem[] = []) {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 5000 && parts.length < 4) {
    let end = remaining.lastIndexOf("\n", 4999) + 1;
    if (end < 2500) end = 5000;
    // Do not cut a surrogate pair when splitting a paragraph with no newline.
    if (/[\uD800-\uDBFF]/u.test(remaining[end - 1] ?? "")) end -= 1;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining.length > 5000) {
    remaining = "剩餘結果超過單次訊息上限，請縮小查詢範圍後取得完整內容。";
  }
  parts.push(remaining || "目前沒有可顯示的內容。");
  return parts.map((part, index) => ({
    type: "text" as const,
    text: part,
    ...(index === parts.length - 1 && quickReplies.length
      ? {
          quickReply: {
            items: quickReplies
              .slice(0, 13)
              .map((item) => ({ type: "action" as const, action: item.action }))
          }
        }
      : {})
  }));
}

/** Leave room for instructions and refuse previews the actual LINE splitter would truncate. */
export function fitsCompleteWritePreview(text: string): boolean {
  return (
    text.length <= 24_000 &&
    buildLineTextMessages(text)
      .map((message) => message.text)
      .join("") === text
  );
}

/** Presentation only: a prompt never grants permission to accept ambient group text. */
export function groupContinuationReply(
  result: FunctionExecutionResult,
  sourceType: string
): FunctionExecutionResult {
  if (sourceType !== "group" || result.writePhase || result.quickReplies?.length) return result;
  const choices = result.agentResult?.clarification?.choices;
  if (
    choices?.length &&
    choices.length <= 13 &&
    choices.every((choice) => choice.length > 0 && choice.length <= 100)
  ) {
    return {
      ...result,
      quickReplies: choices.map((choice) => ({
        label: [...choice].slice(0, 20).join(""),
        action: {
          type: "message" as const,
          label: [...choice].slice(0, 20).join(""),
          text: `選擇：${choice}`
        }
      }))
    };
  }
  const needsInput =
    result.writePreparation === "needs_input" ||
    result.writePreparation === "ambiguous" ||
    result.agentResult?.status === "ambiguous" ||
    /[?？]\s*$/u.test(result.replyText);
  if (!needsInput || /引用回覆|引用這則|重新明確呼叫/u.test(result.replyText)) return result;
  return { ...result, replyText: `${result.replyText}\n請引用回覆這則訊息，或重新明確呼叫我。` };
}
