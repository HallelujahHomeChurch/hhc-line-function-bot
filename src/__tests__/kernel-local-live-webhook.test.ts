import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSignedLineWebhook } from "../evals/kernel/local-live/webhook.js";

describe("Kernel local live webhook construction", () => {
  it("creates one canonical signed LINE text event with opaque identifiers", () => {
    const request = createSignedLineWebhook(
      {
        caseId: "schedule-explicit",
        turnIndex: 0,
        requesterUserId: "U_KERNEL_USER_A",
        source: { type: "user", userId: "U_KERNEL_USER_A" },
        message: { type: "text", text: "synthetic request" }
      },
      "kernel-local-live-channel-secret"
    );

    expect(request.eventId).toBe("schedule-explicit:turn-1");
    expect(request.replyToken).toBe("schedule-explicit-reply-1");
    expect(JSON.parse(request.body.toString("utf8"))).toEqual({
      destination: "kernel-local-live",
      events: [
        {
          type: "message",
          webhookEventId: "schedule-explicit:turn-1",
          deliveryContext: { isRedelivery: false },
          timestamp: 1785024000000,
          replyToken: "schedule-explicit-reply-1",
          source: { type: "user", userId: "U_KERNEL_USER_A" },
          message: {
            type: "text",
            id: "schedule-explicit-message-1",
            text: "synthetic request"
          }
        }
      ]
    });
    expect(request.signature).toBe(
      createHmac("sha256", "kernel-local-live-channel-secret").update(request.body).digest("base64")
    );
  });

  it("constructs file and postback turns without provider or secret fields", () => {
    const file = createSignedLineWebhook(
      {
        caseId: "write-preview-confirm",
        turnIndex: 1,
        requesterUserId: "U_KERNEL_USER_A",
        source: { type: "user", userId: "U_KERNEL_USER_A" },
        message: {
          type: "file",
          id: "synthetic-file-1",
          fileName: "synthetic.txt",
          fileSize: 64
        }
      },
      "kernel-local-live-channel-secret"
    );
    const postback = createSignedLineWebhook(
      {
        caseId: "schedule-ambiguity",
        turnIndex: 1,
        requesterUserId: "U_KERNEL_USER_A",
        source: { type: "user", userId: "U_KERNEL_USER_A" },
        postback: { data: "action=select&index=1" }
      },
      "kernel-local-live-channel-secret"
    );

    expect(JSON.parse(file.body.toString("utf8")).events[0].message).toEqual({
      type: "file",
      id: "synthetic-file-1",
      fileName: "synthetic.txt",
      fileSize: 64
    });
    expect(JSON.parse(postback.body.toString("utf8")).events[0]).toMatchObject({
      type: "postback",
      postback: { data: "action=select&index=1" }
    });
    expect(file.body.toString("utf8")).not.toContain("channel-secret");
  });
});
