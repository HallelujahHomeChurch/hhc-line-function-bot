import { tool } from "langchain";
import { z } from "zod";
import type { FunctionExecutionResult } from "../types.js";
import { takeToolCall } from "./budget.js";

export interface ConversationStateSnapshot {
  status?: "unavailable";
  asOf: string;
  draft: { status: "awaiting_confirmation" | "approval_expired"; action: string } | null;
  attachment: { stage: string } | null;
  task: {
    status: "pending" | "completed" | "failed" | "uncertain" | "context_invalidated";
    createdAt: string;
  } | null;
  media?: {
    state: "active" | "paused" | "unbound" | "unavailable";
    from?: string;
    until?: string;
    totalReceived?: number;
    counts?: Record<string, number>;
  };
}

export function createConversationStateTool(
  read: () => Promise<ConversationStateSnapshot>,
  onRead: (snapshot: ConversationStateSnapshot) => void
) {
  return tool(
    async () => {
      takeToolCall();
      try {
        const snapshot = await read();
        onRead(snapshot);
        return { status: "success", sourceType: "current_conversation", data: snapshot };
      } catch {
        onRead({
          status: "unavailable",
          asOf: new Date().toISOString(),
          draft: null,
          attachment: null,
          task: null
        });
        return { status: "unavailable", sourceType: "current_conversation" };
      }
    },
    {
      name: "get_conversation_state",
      description:
        "即時查詢目前使用者在這段對話的草稿、附件及最近任務狀態；群組媒體狀態另依目前帳戶與資料夾權限取得。完成、處理中、未知結果必須依此結果區分。沒有紀錄不代表已完成；媒體數量僅涵蓋回傳的明確時間範圍。不回傳他人草稿、內容、身份、連結或核准。",
      schema: z.object({}).strict()
    }
  );
}

export function conversationStateReply(
  snapshot: ConversationStateSnapshot
): FunctionExecutionResult {
  if (snapshot.status === "unavailable")
    return { ok: false, replyText: "目前無法查詢工作狀態，不能確認是否完成。請稍後再試。" };
  const lines: string[] = [];
  if (snapshot.draft)
    lines.push(
      snapshot.draft.status === "approval_expired"
        ? "目前草稿的確認已過期，需重新預覽；尚未保存。"
        : "目前有一份待確認草稿，尚未保存。"
    );
  if (snapshot.attachment)
    lines.push(
      `目前有附件待處理：${({ awaiting_opt_in: "等待同意保存", awaiting_purpose: "等待選擇用途", awaiting_title: "等待輸入名稱", awaiting_confirmation: "等待確認保存" } as Record<string, string>)[snapshot.attachment.stage] ?? "尚未完成"}；草稿不代表已發布。`
    );
  if (snapshot.task) {
    const labels = {
      pending: "最近一次任務仍在處理。",
      completed: "最近一次任務已完成；這不代表其他附件或批次都已完成。",
      failed: "最近一次任務未完成。",
      uncertain: "最近一次任務的執行結果尚未確認，請勿重複提交。",
      context_invalidated: "較早任務的上下文已失效，不能直接恢復舊結果。"
    };
    lines.push(labels[snapshot.task.status]);
  }
  if (snapshot.media) {
    if (snapshot.media.state === "unavailable")
      lines.push("目前無法確認媒體同步狀態或讀取權限，不能判定已完成。");
    else if (snapshot.media.state === "unbound") lines.push("這個群組目前沒有有效的媒體同步綁定。");
    else {
      lines.push(
        snapshot.media.state === "paused" ? "群組媒體同步目前暫停。" : "群組媒體同步目前啟用。"
      );
      if (snapshot.media.counts)
        lines.push(
          `統計範圍：${snapshot.media.from} 至 ${snapshot.media.until}。\n收到 ${snapshot.media.totalReceived ?? 0} 筆；已發布 ${snapshot.media.counts.published ?? 0} 筆；處理中 ${(snapshot.media.counts.processing ?? 0) + (snapshot.media.counts.received ?? 0) + (snapshot.media.counts.awaiting_scan ?? 0)} 筆；失敗 ${snapshot.media.counts.failed ?? 0} 筆；已取消 ${snapshot.media.counts.cancelled ?? 0} 筆；已撤回 ${snapshot.media.counts.tombstoned ?? 0} 筆。`
        );
    }
  }
  return {
    ok: true,
    replyText:
      lines.join("\n") || "目前沒有可查詢的草稿、附件或最近任務紀錄；這不代表先前的操作已完成。"
  };
}
