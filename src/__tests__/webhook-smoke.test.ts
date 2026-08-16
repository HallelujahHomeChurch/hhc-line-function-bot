import { describe, expect, it, vi } from "vitest";

import {
  buildSmokeWebhookPayload,
  createSmokeWebhookRequest,
  runSmokeWebhookCli
} from "../tools/smoke-webhook.js";
import { verifyLineSignature } from "../line-signature.js";

describe("webhook smoke tool", () => {
  it("builds a LINE text event payload", () => {
    const body = buildSmokeWebhookPayload({ text: "小哈", userId: "Utest" });
    const parsed = JSON.parse(body);

    expect(parsed.events[0]).toMatchObject({
      type: "message",
      replyToken: "smoke-reply-token",
      source: { type: "user", userId: "Utest" },
      message: { type: "text", text: "小哈" }
    });
  });

  it("signs the body with the LINE channel secret", () => {
    const request = createSmokeWebhookRequest({
      text: "小哈",
      secret: "channel-secret"
    });

    expect(
      verifyLineSignature(
        Buffer.from(request.body),
        request.headers["x-line-signature"],
        "channel-secret"
      )
    ).toBe(true);
  });

  it("does not print the channel secret", async () => {
    const output: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue('{"ok":true}'),
      headers: new Headers({ "x-request-id": "req-1" })
    });

    await runSmokeWebhookCli(
      [
        "--url",
        "https://example.invalid/api/line/webhook/helper",
        "--secret",
        "channel-secret",
        "--text",
        "小哈"
      ],
      { fetchImpl, writeLine: (line) => output.push(line) }
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(output.join("\n")).toContain("status=200");
    expect(output.join("\n")).toContain("requestId=req-1");
    expect(output.join("\n")).not.toContain("channel-secret");
  });
});
