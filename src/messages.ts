import { createSupportId } from "./observability/opaque-identifiers.js";

export const messages = {
  unsupported: "目前不支援這個請求。",
  functionNotConfigured: "這個功能尚未設定完成。",
  requestFailed: "處理請求時發生錯誤，請稍後再試。",
  permissionDenied: "目前這個對話或你的權限不能使用這項功能。輸入 /help 可查看目前可用功能。",
  missingInputNextAction: "請回覆一項需要的資訊。",
  notFoundGuidance: "沒有找到符合條件的結果。請換一個關鍵字或縮小條件後再試。",
  unavailableGuidance: "這項功能目前暫時無法使用，請稍後再試。",
  staleGuidance: "這份較早的資料仍可使用，不會自動重新查詢。",
  postbackExpired: "這個選擇已失效，請重新查詢。",
  postbackUnsupported: "目前不支援這個選擇。",
  adminUnauthorized: "你沒有權限使用 admin 指令。"
} as const;

export function requestFailedMessage(requestId?: string): string {
  return requestId
    ? `${messages.requestFailed}（支援碼：${createSupportId(requestId)}）`
    : messages.requestFailed;
}
