import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import {
  createSaveMemoryHandler,
  createRetrieveMemoryHandler
} from "../functions/agent-memory-functions.js";
import {
  createEvalProbe,
  createSyntheticRuntimeFixture,
  instrumentedFakeModel
} from "../evals/synthetic-runtime-fixture.js";
import { createMemoryCommandHandler } from "../transport/line/memory-commands.js";
import { projectToolResult } from "../helper-agent/tool-result.js";
import { buildLineTextMessages } from "../line-reply.js";
import { backfillAgentTextMemoryEmbeddings } from "../agent/text-memory-embedding-backfill.js";
import type { FunctionHandlerContext, JsonRecord } from "../types.js";

function setup(calls: Array<Array<{ name: string; args: JsonRecord; id: string }>> = []) {
  let clock = new Date("2026-11-02T00:00:00Z");
  const now = () => clock;
  const store = new InMemoryAgentMemoryStore({ now });
  const probe = createEvalProbe();
  const save = createSaveMemoryHandler({ memoryStore: store, now });
  const read = createRetrieveMemoryHandler({ memoryStore: store, now });
  const fixture = createSyntheticRuntimeFixture({
    probe,
    model: instrumentedFakeModel(calls, probe),
    now,
    enabledFunctions: ["save_memory", "retrieve_memory"],
    handlers: { save_memory: save, retrieve_memory: read },
    useCheckedInPolicy: true
  });
  const context: FunctionHandlerContext = {
    profile: fixture.profile,
    event: fixture.turn("合成筆記").event,
    agentTool: true
  };
  return {
    ...fixture,
    store,
    save,
    read,
    context,
    probe,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    }
  };
}

async function seed(
  app: ReturnType<typeof setup>,
  content = "原始內容",
  visibility: "private" | "group" = "private"
) {
  return app.store.saveTextMemory({
    profileName: "helper",
    source: app.context.event.source,
    createdBy: app.context.event.source.userId,
    title: "活動草案",
    content,
    visibility
  });
}
async function approve(app: ReturnType<typeof setup>) {
  const review = await app.sessions.findActionReview({
    profileName: "helper",
    source: app.source,
    requesterUserId: app.source.userId
  });
  if (!review) throw new Error("missing_review");
  return app.runtime.handleActionReview!({
    ...app.turn("確認"),
    reviewId: review.id,
    resultJobId: review.resultJobId,
    text: "確認"
  });
}

describe("helper note lifecycle", () => {
  it("updates beyond the model excerpt with preview, one approval and unchanged expiry", async () => {
    const app = setup([
      [
        {
          name: "propose_save_memory",
          args: { operation: "update", query: "活動草案", oldText: "舊地點", newText: "新地點" },
          id: "edit"
        }
      ],
      []
    ]);
    const original = "前言".repeat(200) + "舊地點 https://example.org/path\n結尾";
    const note = await seed(app, original);
    const preview = await app.runtime.handleTextTurn(app.turn("把活動草案的舊地點改為新地點"));
    expect(preview?.writePhase).toBe("preview");
    expect(preview?.replyText).toContain(original.replace("舊地點", "新地點"));
    expect(
      (await app.store.listTextMemories({ profileName: "helper", source: app.source }))[0]?.content
    ).toBe(original);
    const before = app.probe.values().modelCalls;
    const result = await approve(app);
    expect(result?.result.writePhase).toBe("commit");
    expect(app.probe.values().modelCalls).toBe(before);
    expect(
      (await app.store.listTextMemories({ profileName: "helper", source: app.source }))[0]
    ).toMatchObject({
      id: note.id,
      revision: 2,
      content: original.replace("舊地點", "新地點"),
      expiresAt: note.expiresAt
    });
    await app.runtime.handleTextTurn(app.turn("確認"));
    expect(
      (await app.store.listTextMemories({ profileName: "helper", source: app.source }))[0]?.revision
    ).toBe(2);
  });

  it("saves a new topic after confirmation and retrieves it the next day", async () => {
    const app = setup([
      [
        {
          name: "propose_save_memory",
          args: { title: "旅行構想", content: "週六搭車去公園" },
          id: "save"
        }
      ],
      []
    ]);
    expect(
      (await app.runtime.handleTextTurn(app.turn("請保存旅行構想：週六搭車去公園")))?.writePhase
    ).toBe("preview");
    expect(
      await app.store.listTextMemories({ profileName: "helper", source: app.source })
    ).toHaveLength(0);
    expect((await approve(app))?.result.writePhase).toBe("commit");
    app.advance(86400000);
    expect(
      (await app.read({ operation: "read", query: "旅行構想" }, app.context)).replyText
    ).toContain("週六搭車去公園");
  });

  it("enforces shared-note ownership, current admin access, and source isolation", async () => {
    const app = setup();
    const source = { type: "group" as const, groupId: "synthetic-group", userId: "owner" };
    const record = await app.store.saveTextMemory({
      profileName: "helper",
      source,
      createdBy: "owner",
      visibility: "group",
      content: "原始內容",
      title: "共享草案"
    });
    const other = {
      ...app.context,
      event: { ...app.context.event, source: { ...source, userId: "other" } }
    };
    expect((await app.read({ operation: "read", query: "共享草案" }, other)).replyText).toContain(
      "原始內容"
    );
    expect(
      (await app.save({ operation: "delete", query: "共享草案" }, other)).writePreparation
    ).toBe("denied");
    const preview = await app.save(
      { operation: "delete", query: "共享草案" },
      { ...other, requesterIsAdmin: true }
    );
    expect(preview.reviewArguments).toMatchObject({ memoryId: record.id, expectedRevision: 1 });
    expect(
      (await app.save({ ...preview.reviewArguments, confirm: true }, other)).writePreparation
    ).toBe("denied");
    const wrong = {
      ...other,
      event: { ...other.event, source: { ...source, groupId: "other-group" } }
    };
    expect(
      (await app.save({ ...preview.reviewArguments, confirm: true }, wrong)).writePhase
    ).toBeUndefined();
  });

  it("rejects ambiguous original text and never reconstructs a note from an excerpt", async () => {
    const app = setup();
    await seed(app, "同一句\n同一句");
    expect(
      (
        await app.save(
          { operation: "update", query: "活動草案", oldText: "同一句", newText: "改句" },
          app.context
        )
      ).writePreparation
    ).toBe("ambiguous");
    expect(
      (
        await app.save(
          { operation: "update", query: "活動草案", content: "模型編造全文" },
          app.context
        )
      ).writePreparation
    ).toBe("needs_input");
  });

  it("rejects conflicting update and delete revisions without overwriting", async () => {
    const app = setup();
    const note = await seed(app);
    const preview = await app.save(
      { operation: "update", query: "活動草案", oldText: "原始", newText: "更新" },
      app.context
    );
    await app.store.updateTextMemory({
      profileName: "helper",
      source: app.source,
      id: note.id,
      deletedBy: app.source.userId,
      expectedRevision: 1,
      content: "先完成的修改"
    });
    const failed = await app.save({ ...preview.reviewArguments, confirm: true }, app.context);
    expect(failed.writePreparation).toBe("revision_conflict");
    expect(
      await app.store.forgetMemory({
        profileName: "helper",
        source: app.source,
        id: note.id,
        deletedBy: app.source.userId,
        expectedRevision: 1
      })
    ).toBe(false);
  });

  it("delivers full linked content without a summarizer or full model evidence", async () => {
    const app = setup([
      [{ name: "search_saved_notes", args: { operation: "read", query: "活動草案" }, id: "read" }],
      []
    ]);
    const content = "合成文字".repeat(300) + " https://example.org/notice";
    await seed(app, content);
    const result = await app.runtime.handleTextTurn(app.turn("顯示活動草案全文"));
    expect(result?.replyText).toContain(content);
    expect(
      buildLineTextMessages(result!.replyText)
        .map((m) => m.text)
        .join("")
    ).toBe(result?.replyText);
    expect(
      JSON.stringify(
        projectToolResult(
          await app.read({ operation: "read", query: "活動草案" }, app.context),
          "saved_note"
        )
      )
    ).not.toContain(content);
    expect(app.probe.values().modelCalls).toBe(2);
  });

  it("lists without embedding and prevents cross-source or foreign-owner changes", async () => {
    const app = setup();
    await seed(app);
    const embed = vi.fn();
    const read = createRetrieveMemoryHandler({ memoryStore: app.store, embedding: { embed } });
    expect((await read({ operation: "list" }, app.context)).replyText).toContain("活動草案");
    expect(embed).not.toHaveBeenCalled();
    const foreign = {
      ...app.context,
      event: { ...app.context.event, source: { type: "user" as const, userId: "other" } }
    };
    expect(
      (await app.save({ operation: "delete", query: "活動草案" }, foreign)).writePhase
    ).toBeUndefined();
  });

  it("routes legacy deletion through scoped review without model calls and denies revoked confirmation", async () => {
    const app = setup();
    const note = await seed(app);
    const command = createMemoryCommandHandler({ memoryStore: app.store });
    const prepare = () =>
      app.runtime.prepareActionReview!({
        ...app.turn("刪除"),
        toolName: "propose_save_memory",
        arguments: { operation: "delete", memoryId: note.id }
      });
    expect(
      (
        await command.handleCommand({
          text: `/forget-memory ${note.id}`,
          context: app.context,
          isAdmin: false
        })
      )?.ok
    ).toBe(false);
    expect(
      (
        await command.handleCommand({
          text: `/forget-memory ${note.id}`,
          context: app.context,
          isAdmin: false,
          previewDeletion: prepare
        })
      )?.writePhase
    ).toBe("preview");
    const review = await app.sessions.findActionReview({
      profileName: "helper",
      source: app.source,
      requesterUserId: app.source.userId
    });
    const denied = await app.runtime.handleActionReview!({
      ...app.turn("確認"),
      authorizeFunctions: async () => [],
      reviewId: review!.id,
      resultJobId: review!.resultJobId,
      text: "確認"
    });
    expect(denied?.result.writePhase).not.toBe("commit");
    expect(
      await app.store.listTextMemories({ profileName: "helper", source: app.source })
    ).toHaveLength(1);
    await prepare();
    expect((await approve(app))?.result.writePhase).toBe("commit");
    expect(
      await app.store.listTextMemories({ profileName: "helper", source: app.source })
    ).toHaveLength(0);
    expect(app.probe.values().modelCalls).toBe(0);
  });

  it("fences embedding backfill racing a content update", async () => {
    const app = setup();
    const note = await seed(app);
    const result = await backfillAgentTextMemoryEmbeddings({
      store: app.store,
      batchSize: 10,
      embedding: {
        embed: async () => {
          await app.store.updateTextMemory({
            profileName: "helper",
            source: app.source,
            id: note.id,
            deletedBy: app.source.userId,
            expectedRevision: 1,
            content: "全新內容"
          });
          return [[1, 0]];
        }
      }
    });
    expect(result.updated).toBe(0);
    expect((await app.store.listTextMemoriesMissingEmbedding(10))[0]).toMatchObject({
      content: "全新內容",
      revision: 2
    });
  });

  it("rejects expired approvals and oversized previews", async () => {
    const app = setup();
    const note = await seed(app);
    await app.runtime.prepareActionReview!({
      ...app.turn("刪除"),
      toolName: "propose_save_memory",
      arguments: { operation: "delete", memoryId: note.id }
    });
    app.advance(6 * 60_000);
    expect((await approve(app))?.result.writePhase).not.toBe("commit");
    const large = await app.save({ content: "字".repeat(24_001) }, app.context);
    expect(large.writePhase).toBeUndefined();
  });
});
