import { messagingApi } from "@line/bot-sdk";

import type { BotProfileConfig, LineReplyClient } from "../types.js";

export function createLineSdkReplyClient(profile: BotProfileConfig): LineReplyClient {
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: profile.channelAccessToken
  });

  return {
    async replyText(replyToken: string, text: string): Promise<void> {
      await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text }]
      });
    }
  };
}
