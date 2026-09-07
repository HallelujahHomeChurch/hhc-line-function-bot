import { createHash } from "node:crypto";
import { createPendingAttachmentPostbackHandler } from "../transport/line/attachment-intake.js";
import type { PendingAttachmentSession } from "../state/session-store.js";
import { createHelperWriteTools } from "../helper-agent/write-tools.js";
import { getFunctionDefinition } from "../capabilities/catalog.js";
import { describe, expect, it, vi } from "vitest";

import {
  createEvalProbe,
  createSyntheticRuntimeFixture,
  instrumentedFakeModel
} from "../evals/synthetic-runtime-fixture.js";
import type { FunctionHandler } from "../types.js";

const proposal = (content: string, id: string) => ({
  name: "propose_save_memory",
  args: { content },
  id
});

function fixture(script: ReturnType<typeof proposal>[][], handler?: FunctionHandler) {
  const probe = createEvalProbe();
  const save = vi.fn<FunctionHandler>(
    handler ??
      (async (args) => ({
        ok: true,
        replyText: String(args.content),
        writePhase: args.confirm === true ? "commit" : "preview"
      }))
  );
  const app = createSyntheticRuntimeFixture({
    model: instrumentedFakeModel(script, probe),
    probe,
    enabledFunctions: ["save_memory"],
    handlers: { save_memory: save }
  });
  const review = () =>
    app.sessions.findActionReview({
      profileName: app.profile.name,
      source: app.source,
      requesterUserId: app.source.userId!
    });
  return { ...app, save, review };
}

describe("helper draft experience", () => {
  it("returns the authoritative preview if generation fails after proposal and confirms only shown arguments", async () => {
    const app = fixture([[proposal("shown draft", "first")], []]);
    const started = app.probe.started;
    app.probe.started = (messages) => {
      started(messages);
      if (app.probe.values().modelCalls === 2) throw new Error("synthetic post-proposal failure");
    };
    const result = await app.runtime.handleTextTurn(app.turn("請記住 shown draft"));
    expect(result).toMatchObject({ writePhase: "preview", replyText: "shown draft" });
    expect((await app.review())?.draftArguments).toMatchObject({ content: "shown draft" });
    const committed = await app.runtime.handleTextTurn(app.turn("確認"));
    expect(committed?.writePhase).toBe("commit");
    const commits = app.save.mock.calls.filter(([args]) => args.confirm === true);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.[0].content).toBe(result?.replyText);
  });

  it("allows only one active preview when the model proposes two writes in parallel", async () => {
    const app = fixture([
      [proposal("first draft", "first"), proposal("second draft", "second")],
      []
    ]);
    const result = await app.runtime.handleTextTurn(app.turn("請記住這兩項偏好"));
    expect(app.save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ writePhase: "preview", replyText: "first draft" });
    expect((await app.sessions.summary()).byType.action_review).toBe(1);
    expect((await app.review())?.draftArguments).toMatchObject({ content: "first draft" });
  });

  it("keeps original draft arguments after invalid revision but invalidates its approval", async () => {
    const app = fixture(
      [[proposal("original draft", "first")], [], [proposal("incomplete revision", "second")], []],
      async (args) => {
        if (args.content === "incomplete revision")
          return { ok: true, writePreparation: "needs_input", replyText: "請補充內容" };
        return {
          ok: true,
          replyText: String(args.content),
          writePhase: args.confirm === true ? "commit" : "preview"
        };
      }
    );
    await app.runtime.handleTextTurn(app.turn("請記住 original draft"));
    const original = await app.review();
    await app.runtime.handleTextTurn(app.turn("請修改成不完整的新內容"));
    const retained = await app.review();
    expect(retained?.draftArguments).toEqual(original?.draftArguments);
    expect(retained?.approvalExpiresAt).toBe("2026-09-04T00:00:00.000Z");
    const confirm = await app.runtime.handleTextTurn(app.turn("確認"));
    expect(confirm?.writePhase).not.toBe("commit");
    expect(app.save.mock.calls.filter(([args]) => args.confirm === true)).toHaveLength(0);
  });
});

it("exposes the canonical single-or-multiple-row draft contract separately from read-only lookup", () => {
  const app = fixture([[]]);
  const tools = createHelperWriteTools({
    context: {
      profile: { ...app.profile, enabledFunctions: ["save_schedule"] },
      event: app.turn("synthetic").event
    },
    propose: async () => ({ status: "preview" })
  });
  const description = tools.find(({ name }) => name === "propose_save_schedule")?.description;
  expect(description).toContain(
    getFunctionDefinition("save_schedule")?.agentCapability?.semanticDescription
  );
  expect(description).toContain("單筆或多筆");
  expect(description).toContain("尚未保存");
  expect(getFunctionDefinition("query_schedule")?.agentCapability?.semanticDescription).toContain(
    "不會保存"
  );
});

it("reset waits for an in-flight proposal and invalidates the review it creates", async () => {
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const app = fixture([[proposal("pending draft", "pending")], []], async () => {
    reached();
    await waiting;
    return { ok: true, writePhase: "preview", replyText: "pending draft" };
  });
  const proposalTurn = app.runtime.handleTextTurn(app.turn("記住 pending draft"));
  await entered;
  const resetTurn = app.runtime.handleTextTurn(app.turn("忘記這段對話"));
  await Promise.resolve();
  release();
  await proposalTurn;
  await resetTurn;
  expect(await app.review()).toBeUndefined();
});

it("reset invalidates an old attachment approval and scoped research while preserving another requester", async () => {
  const app = fixture([[]]);
  const pending: PendingAttachmentSession = {
    id: "attachment",
    type: "pending_attachment",
    action: "save_resource",
    stage: "awaiting_confirmation",
    profileName: "helper",
    requesterUserId: app.source.userId,
    source: app.source,
    attachment: { messageId: "file", messageType: "file" },
    target: { sourceKey: "music", itemKind: "pop_sheet", domain: "music", title: "synthetic" },
    expiresAt: "2026-09-04T00:10:00Z"
  };
  const revision = createHash("sha256").update(JSON.stringify(pending)).digest("hex");
  await app.sessions.set(pending);
  await app.sessions.set({
    id: "consent",
    type: "external_search_consent",
    action: "sheet_music_external_search",
    profileName: "helper",
    source: app.source,
    requesterUserId: app.source.userId,
    query: "synthetic",
    expiresAt: pending.expiresAt
  });
  await app.sessions.set({
    id: "import",
    type: "external_sheet_music_import",
    stage: "selecting",
    profileName: "helper",
    source: app.source,
    requesterUserId: app.source.userId,
    query: "synthetic",
    items: [],
    expiresAt: pending.expiresAt
  });
  const other = {
    ...pending,
    id: "other",
    requesterUserId: "U2",
    source: { type: "user", userId: "U2" }
  };
  await app.sessions.set(other);
  await app.runtime.handleTextTurn(app.turn("忘記這段對話"));
  expect(await app.sessions.get(pending.id)).toBeUndefined();
  expect(await app.sessions.get("consent")).toBeUndefined();
  expect(await app.sessions.get("import")).toBeUndefined();
  expect(await app.sessions.get("other")).toBeDefined();
  const handler = createPendingAttachmentPostbackHandler({
    sessionStore: app.sessions
  } as Parameters<typeof createPendingAttachmentPostbackHandler>[0]);
  const result = await handler(
    { action: "confirm_attachment", params: { revision } },
    {
      profile: { ...app.profile, enabledFunctions: ["save_resource"] },
      event: app.turn("保存附件").event
    }
  );
  expect(result.replyText).toContain("已失效");
  await app.sessions.set({
    id: "upload",
    type: "upload_intent",
    profileName: "helper",
    requesterUserId: app.source.userId!,
    source: app.source,
    expiresAt: pending.expiresAt
  });
  await app.runtime.handleTextTurn(app.turn("忘記這段對話"));
  expect(await app.sessions.get("upload")).toBeUndefined();
});
