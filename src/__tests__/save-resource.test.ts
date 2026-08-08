import { describe, expect, it } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { createSaveResourceHandler } from "../functions/save-resource.js";
import type { BotProfileConfig, FunctionHandlerContext } from "../types.js";

function context(): FunctionHandlerContext {
  return {
    requestId: "req-1",
    profile: {
      name: "helper",
      webhookPath: "/api/line/webhook/helper",
      channelSecret: "secret",
      channelAccessToken: "token",
      allowDirectUser: true,
      allowRooms: false,
      allowedMessageTypes: ["text"],
      groupRequireWakeWord: true,
      wakeKeywords: ["小哈"],
      acceptMention: true,
      enabledFunctions: ["save_resource"],
      permissionRequiredFunctions: []
    } satisfies BotProfileConfig,
    event: {
      type: "message",
      source: { type: "group", groupId: "C1", userId: "U1" },
      message: { type: "text", text: "保存投影片" }
    }
  };
}

describe("save_resource", () => {
  it("previews an HTTPS resource and writes it only after confirmation", async () => {
    const store = new InMemoryAgentMemoryStore();
    const handler = createSaveResourceHandler({ memoryStore: store });
    const args = {
      url: "https://example.org/youth",
      resourceType: "ppt_slide" as const,
      title: "青年聚會投影片"
    };

    await expect(handler(args, context())).resolves.toMatchObject({
      replyText: expect.stringContaining("要保存嗎")
    });
    await expect(store.summary()).resolves.toMatchObject({ resources: 0 });

    await expect(handler({ ...args, confirm: true }, context())).resolves.toMatchObject({
      replyText: "已保存：青年聚會投影片"
    });
    await expect(
      store.searchResources({
        profileName: "helper",
        source: context().event.source,
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject([
      expect.objectContaining({ title: "青年聚會投影片", visibility: "private" })
    ]);
  });

  it("rejects HTTP and does not persist it", async () => {
    const store = new InMemoryAgentMemoryStore();
    const handler = createSaveResourceHandler({ memoryStore: store });

    await expect(
      handler(
        {
          url: "http://example.org/youth",
          resourceType: "ppt_slide",
          title: "青年聚會投影片",
          confirm: true
        },
        context()
      )
    ).resolves.toMatchObject({ replyText: "請提供有效的 HTTPS 連結。" });
    await expect(store.summary()).resolves.toMatchObject({ resources: 0 });
  });
});
