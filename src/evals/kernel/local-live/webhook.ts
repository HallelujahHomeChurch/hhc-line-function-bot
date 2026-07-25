import { createHmac } from "node:crypto";

import type { KernelLocalLiveCaseId } from "./contracts.js";

const FIXED_TIMESTAMP = Date.UTC(2026, 6, 26, 0, 0, 0);

export type KernelLocalLiveSource =
  { type: "user"; userId: string } | { type: "group"; groupId: string; userId: string };

export type KernelLocalLiveMessage =
  { type: "text"; text: string } | { type: "file"; id: string; fileName: string; fileSize: number };

export interface KernelLocalLiveTurn {
  caseId: KernelLocalLiveCaseId;
  turnIndex: number;
  requesterUserId: string;
  source: KernelLocalLiveSource;
  message?: KernelLocalLiveMessage;
  postback?: { data: string };
}

export interface SignedWebhookRequest {
  body: Buffer;
  signature: string;
  eventId: string;
  replyToken: string;
}

export function createSignedLineWebhook(
  turn: KernelLocalLiveTurn,
  channelSecret: string
): SignedWebhookRequest {
  if (
    !Number.isInteger(turn.turnIndex) ||
    turn.turnIndex < 0 ||
    turn.source.userId !== turn.requesterUserId ||
    (turn.message ? 1 : 0) + (turn.postback ? 1 : 0) !== 1
  ) {
    throw new Error("kernel_local_live_turn_invalid");
  }
  const ordinal = turn.turnIndex + 1;
  const eventId = `${turn.caseId}:turn-${ordinal}`;
  const replyToken = `${turn.caseId}-reply-${ordinal}`;
  const event = turn.message
    ? {
        type: "message",
        webhookEventId: eventId,
        deliveryContext: { isRedelivery: false },
        timestamp: FIXED_TIMESTAMP,
        replyToken,
        source: turn.source,
        message:
          turn.message.type === "text"
            ? {
                type: "text",
                id: `${turn.caseId}-message-${ordinal}`,
                text: turn.message.text
              }
            : turn.message
      }
    : {
        type: "postback",
        webhookEventId: eventId,
        deliveryContext: { isRedelivery: false },
        timestamp: FIXED_TIMESTAMP,
        replyToken,
        source: turn.source,
        postback: turn.postback
      };
  const body = Buffer.from(
    JSON.stringify({
      destination: "kernel-local-live",
      events: [event]
    }),
    "utf8"
  );
  return {
    body,
    signature: createHmac("sha256", channelSecret).update(body).digest("base64"),
    eventId,
    replyToken
  };
}
