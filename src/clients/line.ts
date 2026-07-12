import type { Readable } from "node:stream";

import { Client as LineClient, messagingApi } from "@line/bot-sdk";

import type {
  BotProfileConfig,
  BinaryReadLimits,
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
    async getMessageContent(
      messageId: string,
      profile: BotProfileConfig,
      limits: BinaryReadLimits
    ) {
      let client = clients.get(profile.name);
      if (!client) {
        client = new LineClient({ channelAccessToken: profile.channelAccessToken });
        clients.set(profile.name, client);
      }
      const stream = await client.getMessageContent(messageId);
      return {
        data: await readableToUint8Array(stream, limits)
      };
    }
  };
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class LineContentReadError extends Error {
  constructor(
    public readonly code: "line_content_too_large" | "line_content_timeout" | "line_content_empty"
  ) {
    super(code);
    this.name = "LineContentReadError";
  }
}

export async function readableToUint8Array(
  stream: Readable,
  limits: BinaryReadLimits
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;

  const read = async (): Promise<Uint8Array> => {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > limits.maxBytes) {
        stream.destroy();
        throw new LineContentReadError("line_content_too_large");
      }
      chunks.push(buffer);
    }
    if (size === 0) {
      throw new LineContentReadError("line_content_empty");
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  };

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new LineContentReadError("line_content_timeout");
      stream.destroy(error);
      reject(error);
    }, limits.timeoutMs);
  });

  try {
    return await Promise.race([read(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
