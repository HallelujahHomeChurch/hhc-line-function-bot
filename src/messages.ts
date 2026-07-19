import { createSupportId } from "./observability/opaque-identifiers.js";

export const messages = {
  unsupported: "目前不支援這個請求。",
  functionNotConfigured: "這個功能尚未設定完成。",
  requestFailed: "處理請求時發生錯誤，請稍後再試。",
  postbackExpired: "這個選擇已失效，請重新查詢。",
  postbackUnsupported: "目前不支援這個選擇。",
  adminUnauthorized: "你沒有權限使用 admin 指令。"
} as const;

export function requestFailedMessage(requestId?: string): string {
  return requestId
    ? `${messages.requestFailed}（支援碼：${createSupportId(requestId)}）`
    : messages.requestFailed;
}
