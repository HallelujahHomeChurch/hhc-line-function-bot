import { Readable } from "node:stream";

import { LineBotClient, messagingApi } from "@line/bot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contentTypeFromLineStream,
  createLineSdkAccountLinkClient,
  createLineSdkContentClient,
  createLineSdkReplyClient,
  readableToUint8Array
} from "../clients/line.js";
import type { BotProfileConfig } from "../types.js";

afterEach(() => vi.restoreAllMocks());

describe("LINE account link tokens", () => {
  const profile = { channelAccessToken: "profile-token" } as BotProfileConfig;

  it("returns the nonblank native link token issued for the exact LINE user", async () => {
    const issueLinkToken = vi
      .spyOn(messagingApi.MessagingApiClient.prototype, "issueLinkToken")
      .mockResolvedValue({ linkToken: " native-link-token " });

    await expect(createLineSdkAccountLinkClient(profile).issueLinkToken("Uuser")).resolves.toBe(
      "native-link-token"
    );
    expect(issueLinkToken).toHaveBeenCalledWith("Uuser");
  });

  it("rejects a blank SDK response", async () => {
    vi.spyOn(messagingApi.MessagingApiClient.prototype, "issueLinkToken").mockResolvedValue({
      linkToken: " "
    });

    await expect(createLineSdkAccountLinkClient(profile).issueLinkToken("Uuser")).rejects.toThrow(
      "line_link_token_invalid"
    );
  });

  it("does not hide SDK issuance failures", async () => {
    vi.spyOn(messagingApi.MessagingApiClient.prototype, "issueLinkToken").mockRejectedValue(
      new Error("sdk unavailable")
    );

    await expect(createLineSdkAccountLinkClient(profile).issueLinkToken("Uuser")).rejects.toThrow(
      "sdk unavailable"
    );
  });
});

describe("LINE URI quick replies", () => {
  it("serializes the SDK-native URI action without copying the URL into message text", async () => {
    const replyMessage = vi
      .spyOn(messagingApi.MessagingApiClient.prototype, "replyMessage")
      .mockResolvedValue({ sentMessages: [] });
    const profile = {
      channelAccessToken: "profile-token"
    } as BotProfileConfig;

    await createLineSdkReplyClient(profile).replyText("reply-token", "週報已準備好。", {
      quickReplies: [
        {
          label: "下載週報",
          action: {
            type: "uri",
            label: "下載週報",
            uri: "https://www.alive.org.tw/assets/0123456789abcdef0123456789abcdef"
          }
        }
      ]
    });

    expect(replyMessage).toHaveBeenCalledWith({
      replyToken: "reply-token",
      messages: [
        {
          type: "text",
          text: "週報已準備好。",
          quickReply: {
            items: [
              {
                type: "action",
                action: {
                  type: "uri",
                  label: "下載週報",
                  uri: "https://www.alive.org.tw/assets/0123456789abcdef0123456789abcdef"
                }
              }
            ]
          }
        }
      ]
    });
  });
});

describe("LINE content streaming", () => {
  it("returns the SDK stream without buffering it for media sync", async () => {
    const stream = Readable.from([Buffer.from("media")]);
    Object.assign(stream, { headers: { "content-type": "video/mp4; charset=binary" } });
    const getMessageContent = vi
      .spyOn(LineBotClient.prototype, "getMessageContent")
      .mockResolvedValue(stream);

    const result = await createLineSdkContentClient().getMessageContentStream!("message-1", {
      name: "helper",
      channelAccessToken: "token"
    });

    expect(result).toEqual({ stream, contentType: "video/mp4" });
    expect(getMessageContent).toHaveBeenCalledWith("message-1");
    expect(stream.readableEnded).toBe(false);
  });

  it.each(["processing", "succeeded", "failed"] as const)(
    "returns the exact %s transcoding state",
    async (status) => {
      const getStatus = vi
        .spyOn(LineBotClient.prototype, "getMessageContentTranscodingByMessageId")
        .mockResolvedValue({ status });

      await expect(
        createLineSdkContentClient().getMessageContentTranscodingStatus!("message-1", {
          name: "helper",
          channelAccessToken: "token"
        })
      ).resolves.toBe(status);
      expect(getStatus).toHaveBeenCalledWith("message-1");
    }
  );

  it("retains a safe response content type for worker-side extension validation", () => {
    const stream = Readable.from([]);
    Object.assign(stream, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      }
    });

    expect(contentTypeFromLineStream(stream)).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
  });

  it("accepts content at the exact byte limit", async () => {
    await expect(
      readableToUint8Array(Readable.from([Buffer.from([1, 2, 3, 4])]), {
        maxBytes: 4,
        timeoutMs: 100
      })
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("rejects content as soon as it exceeds the byte limit", async () => {
    await expect(
      readableToUint8Array(Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4, 5])]), {
        maxBytes: 4,
        timeoutMs: 100
      })
    ).rejects.toMatchObject({ code: "line_content_too_large" });
  });

  it("rejects an empty stream", async () => {
    await expect(
      readableToUint8Array(Readable.from([]), { maxBytes: 4, timeoutMs: 100 })
    ).rejects.toMatchObject({ code: "line_content_empty" });
  });

  it("destroys a stream that exceeds the deadline", async () => {
    const stream = new Readable({ read() {} });

    await expect(readableToUint8Array(stream, { maxBytes: 4, timeoutMs: 5 })).rejects.toMatchObject(
      { code: "line_content_timeout" }
    );
    expect(stream.destroyed).toBe(true);
  });
});
