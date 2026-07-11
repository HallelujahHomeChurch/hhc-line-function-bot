import type { Readable } from "node:stream";

import { Client as LineClient, messagingApi } from "@line/bot-sdk";

import type {
  BotProfileConfig,
  LineContentClient,
  LineIdentityClient,
  LineReplyClient,
  LineReplyOptions
} from "../types.js";

export function createLineSdkReplyClient(profile: BotProfileConfig): LineReplyClient {
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: profile.channelAccessToken
  });

  return {
    async replyText(replyToken: string, text: string, options?: LineReplyOptions): Promise<void> {
      await client.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text,
            ...(options?.quickReplies?.length
              ? {
                  quickReply: {
                    items: options.quickReplies.map((item) => ({
                      type: "action",
                      action: item.action
                    }))
                  }
                }
              : {})
          }
        ]
      });
    }
  };
}

export function createLineSdkIdentityClient(profile: BotProfileConfig): LineIdentityClient {
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: profile.channelAccessToken
  });

  return {
    async getUserDisplayName(userId: string): Promise<string | undefined> {
      const profile = await client.getProfile(userId);
      return nonBlank(profile.displayName);
    },

    async getGroupDisplayName(groupId: string): Promise<string | undefined> {
      const summary = await client.getGroupSummary(groupId);
      return nonBlank(summary.groupName);
    }
  };
}

export function createLineSdkContentClient(): LineContentClient {
  const clients = new Map<string, LineClient>();
  return {
    async getMessageContent(messageId: string, profile?: BotProfileConfig) {
      if (!profile) {
        throw new Error("line_profile_required_for_content");
      }
      let client = clients.get(profile.name);
      if (!client) {
        client = new LineClient({ channelAccessToken: profile.channelAccessToken });
        clients.set(profile.name, client);
      }
      const stream = await client.getMessageContent(messageId);
      return {
        data: await readableToUint8Array(stream)
      };
    }
  };
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function readableToUint8Array(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}
