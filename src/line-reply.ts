import type { QuickReplyItem } from "./types.js";

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
