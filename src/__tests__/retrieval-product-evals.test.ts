import { describe, expect, it, vi } from "vitest";

import { RETRIEVAL_PRODUCT_CASES } from "../evals/fixtures/retrieval-product-cases.js";
import { createFindPptSlidesHandler } from "../functions/find-ppt-slides.js";
import type { FunctionHandlerContext, GraphDriveClient } from "../types.js";

describe("retrieval product regression corpus", () => {
  it("keeps every R0 retrieval lifecycle scenario in the offline corpus", () => {
    expect(new Set(RETRIEVAL_PRODUCT_CASES)).toEqual(
      new Set([
        "sequential_ppt_queries",
        "legacy_alias_cannot_execute",
        "active_task_follow_up",
        "schedule_domain_ambiguity",
        "explicit_schedule_domain",
        "retrieval_not_found",
        "retrieval_unavailable",
        "catalog_publication_atomic",
        "resource_memory_rank_only",
        "resource_reference_validation",
        "fresh_second_provider_query",
        "write_preview_commit_precedence"
      ])
    );
  });

  it("performs two different PPT searches instead of replaying the first result", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        { id: "ppt-a", name: "第一份投影片.pptx" },
        { id: "ppt-b", name: "第二份投影片.pptx" }
      ]),
      getItemById: vi.fn(async (_driveId, itemId) => ({ id: itemId, name: "current-item" })),
      createSharingLink: vi.fn(async (_driveId, itemId) => `https://download.invalid/${itemId}`)
    };
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive",
      folderItemId: "folder",
      allowedExtensions: [".pptx"],
      defaultIncludePdf: false,
      observabilityHmacKey: "0123456789abcdef0123456789abcdef"
    });
    const context: FunctionHandlerContext = {
      profile: {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: false,
        wakeKeywords: [],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides"]
      },
      event: {
        type: "message",
        source: { type: "user", userId: "U1" },
        message: { type: "text", text: "查投影片" }
      }
    };

    const first = await handler({ query: "第一份投影片", matchMode: "exact" }, context);
    const second = await handler({ query: "第二份投影片", matchMode: "exact" }, context);

    expect(first.replyText).toContain("ppt-a");
    expect(second.replyText).toContain("ppt-b");
    expect(first.diagnostics?.queryFingerprint).not.toBe(second.diagnostics?.queryFingerprint);
    expect(graph.listFolderChildren).toHaveBeenCalledTimes(2);
  });
});
