import { MemorySaver, REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { AIMessage, FakeToolCallingModel } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { createHelperAgent } from "../helper-agent/agent.js";
import { createHelperWriteTools } from "../helper-agent/write-tools.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { FunctionHandlerContext } from "../types.js";

const context = {
  profile: { name: "helper", enabledFunctions: ["save_memory"] },
  event: { source: { type: "group", groupId: "synthetic-group", userId: "synthetic-user" } }
} as FunctionHandlerContext;

async function fixture(content = "原句：甲組", authorize = vi.fn(async () => true)) {
  const sessions = new InMemorySessionStore();
  const jobs = new InMemoryAgentJobStore();
  const jobRecord = await jobs.createPending({
    scope: {
      profileName: "helper",
      sourceType: "group",
      sourceId: "synthetic-group",
      requesterUserId: "synthetic-user"
    },
    capability: "save_memory",
    label: "action-review",
    ttlMs: 60_000
  });
  const propose = vi.fn(async () => ({ status: "preview" }));
  await sessions.set({
    id: "draft",
    type: "action_review",
    profileName: "helper",
    requesterUserId: "synthetic-user",
    source: context.event.source,
    toolName: "propose_save_memory",
    draftArguments: { title: "完整草稿", content, visibility: "group" },
    argumentsHash: "opaque",
    policyKey: "policy",
    resultJobId: jobRecord.id,
    approvalExpiresAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const options = {
    context,
    sessions,
    jobs,
    propose,
    authorize,
    hasCurrentDraft: true,
    currentPolicyKey: async () => "policy",
    beforeCancel: () => true
  };
  const tools = createHelperWriteTools(options);
  return {
    sessions,
    jobs,
    jobId: jobRecord.id,
    propose,
    tools,
    options,
    get: (name: string) => tools.find((tool) => tool.name === name)!
  };
}

describe("server-owned current draft", () => {
  it("revises exact server text after the SDK message history was replaced by a summary", async () => {
    const original = "甲".repeat(2500) + "唯一舊句" + "乙".repeat(2500);
    const { tools, propose } = await fixture(original);
    const model = new FakeToolCallingModel({
      toolCalls: [
        [{ name: "get_current_draft", args: {}, id: "get" }],
        [
          {
            name: "revise_current_draft",
            args: { oldText: "唯一舊句", newText: "唯一新句" },
            id: "revise"
          }
        ],
        []
      ]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const agent = createHelperAgent({
      model,
      summaryModel: model,
      tools,
      checkpointer: new MemorySaver()
    });
    const config = { configurable: { thread_id: "draft-recovery" } };
    await agent.updateState(config, { messages: [{ role: "user", content: original }] });
    await agent.updateState(config, {
      messages: [
        { role: "remove", id: REMOVE_ALL_MESSAGES, content: "" },
        new AIMessage("使用者有一份長草稿，原文已不在摘要。")
      ]
    });
    await agent.invoke({ messages: [{ role: "user", content: "把唯一舊句改成唯一新句" }] }, config);
    expect(propose).toHaveBeenCalledExactlyOnceWith("propose_save_memory", {
      title: "完整草稿",
      visibility: "group",
      content: original.replace("唯一舊句", "唯一新句")
    });
  });

  it("bounds evidence, strips URLs and can repreview an expired approval from exact arguments", async () => {
    const { get, propose } = await fixture("https://private.example.test " + '"\n'.repeat(2000));
    const result = await get("get_current_draft").invoke({});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(result)).not.toContain("https://");
    expect(result).toMatchObject({ truncated: true });
    await get("preview_current_draft").invoke({});
    expect(propose).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous edits and rechecks revoked authorization without proposing", async () => {
    const authorize = vi.fn(async () => true);
    const { get, propose } = await fixture("甲組；甲組", authorize);
    await expect(
      get("revise_current_draft").invoke({ oldText: "甲組", newText: "乙組" })
    ).resolves.toMatchObject({ status: "ambiguous" });
    await expect(
      get("revise_current_draft").invoke({ oldText: "不存在", newText: "乙組" })
    ).resolves.toMatchObject({ status: "not_found" });
    authorize.mockResolvedValue(false);
    await expect(
      get("revise_current_draft").invoke({ oldText: "甲組；甲組", newText: "乙組" })
    ).resolves.toMatchObject({ status: "denied" });
    expect(propose).not.toHaveBeenCalled();
    await expect(
      get("revise_current_draft").invoke({ oldText: "甲", newText: "乙", confirm: true })
    ).rejects.toThrow();
  });

  it("hides extra tools without a current draft and denies another requester", async () => {
    const { options, propose } = await fixture();
    expect(
      createHelperWriteTools({ ...options, hasCurrentDraft: false }).map((tool) => tool.name)
    ).toEqual(["propose_save_memory"]);
    const other = {
      ...context,
      event: { ...context.event, source: { ...context.event.source, userId: "other" } }
    };
    const get = createHelperWriteTools({ ...options, context: other }).find(
      (tool) => tool.name === "get_current_draft"
    )!;
    await expect(get.invoke({})).resolves.toMatchObject({ status: "denied" });
    expect(propose).not.toHaveBeenCalled();
  });

  it("refuses expired or policy-invalidated drafts and cancels a valid draft once", async () => {
    const { options, sessions, jobs, jobId, get, propose } = await fixture();
    for (const extra of [
      { now: () => new Date(Date.now() + 120_000) },
      { currentPolicyKey: async () => "changed-policy" }
    ]) {
      const recover = createHelperWriteTools({ ...options, ...extra }).find(
        (tool) => tool.name === "get_current_draft"
      )!;
      await expect(recover.invoke({})).resolves.toMatchObject({ status: "denied" });
    }
    await expect(get("cancel_current_draft").invoke({})).resolves.toMatchObject({
      status: "cancelled"
    });
    await expect(get("cancel_current_draft").invoke({})).resolves.toMatchObject({
      status: "denied"
    });
    expect(await sessions.get("draft")).toBeUndefined();
    const job = await jobs.get(jobId, {
      profileName: "helper",
      sourceType: "group",
      sourceId: "synthetic-group",
      requesterUserId: "synthetic-user"
    });
    expect(job?.status).toBe("failed");
    expect(propose).not.toHaveBeenCalled();
  });

  it("honors the shared mutation gate before cancelling", async () => {
    const { options, sessions } = await fixture();
    const fail = vi.spyOn(options.jobs, "fail");
    const cancel = createHelperWriteTools({ ...options, beforeCancel: () => false }).find(
      (tool) => tool.name === "cancel_current_draft"
    )!;
    await expect(cancel.invoke({})).resolves.toMatchObject({ status: "denied" });
    expect(await sessions.get("draft")).toBeDefined();
    expect(fail).not.toHaveBeenCalled();
  });
});

it("updates structured assignee fields together with original text without discarding untouched entries", async () => {
  const { sessions, options, propose } = await fixture("9/13 合成甲組\n10/4 合成乙組");
  const draft = await sessions.get("draft");
  if (!draft || draft.type !== "action_review") throw new Error("missing draft");
  const entries = [
    {
      serviceDate: "2026-09-13",
      meetingName: "服事",
      assignee: "合成甲組",
      familyName: "合成甲組"
    },
    { serviceDate: "2026-10-04", meetingName: "服事", assignee: "合成乙組" }
  ];
  await sessions.set({
    ...draft,
    toolName: "propose_save_schedule",
    draftArguments: { content: "9/13 合成甲組\n10/4 合成乙組", entries }
  });
  const tools = createHelperWriteTools({
    ...options,
    context: { ...context, profile: { ...context.profile, enabledFunctions: ["save_schedule"] } }
  });
  await tools
    .find((tool) => tool.name === "revise_current_draft")!
    .invoke({ oldText: "合成甲組", newText: "合成丙組" });
  expect(propose).toHaveBeenCalledWith(
    "propose_save_schedule",
    expect.objectContaining({
      entries: [{ ...entries[0], assignee: "合成丙組", familyName: "合成丙組" }, entries[1]]
    })
  );
});

it("edits a normalized date without reconstructing other structured entries", async () => {
  const { sessions, options, propose } = await fixture("9/13 合成甲組");
  const draft = await sessions.get("draft");
  if (!draft || draft.type !== "action_review") throw new Error("missing draft");
  const entries = [{ serviceDate: "2026-09-13", meetingName: "服事", assignee: "合成甲組" }];
  await sessions.set({
    ...draft,
    toolName: "propose_save_schedule",
    draftArguments: { content: "9/13 合成甲組", entries }
  });
  const beforeRevise = vi.fn(async () => true);
  const tools = createHelperWriteTools({
    ...options,
    beforeRevise,
    context: { ...context, profile: { ...context.profile, enabledFunctions: ["save_schedule"] } }
  });
  await tools
    .find((tool) => tool.name === "revise_current_draft")!
    .invoke({
      entryDate: "2026-09-13",
      field: "serviceDate",
      oldText: "2026-09-13",
      newText: "2026-09-20"
    });
  expect(beforeRevise).toHaveBeenCalledOnce();
  expect(propose).toHaveBeenCalledWith("propose_save_schedule", {
    content: "9/13 合成甲組",
    entries: [{ ...entries[0], serviceDate: "2026-09-20" }]
  });
});
