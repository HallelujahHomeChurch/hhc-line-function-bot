import { MemorySaver } from "@langchain/langgraph";
import { FakeToolCallingModel } from "langchain";
import { describe, expect, it, vi } from "vitest";

import { buildAgentJobScope, InMemoryAgentJobStore } from "../agent/jobs.js";
import { createHelperAgent } from "../helper-agent/agent.js";
import {
  createActionReviewLifecycleObserver,
  createActionReview,
  hashReviewArguments,
  resumeHelperReview
} from "../helper-agent/review.js";
import { createHelperWriteTools } from "../helper-agent/write-tools.js";
import { createActionExecutor, type ActionExecution } from "../runtime/action-executor.js";
import { DEFAULT_SCHEDULE_DOMAINS } from "../schedules/domain-registry.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { BotProfileConfig, FunctionHandlerContext } from "../types.js";

const NOW = new Date("2026-09-04T00:00:00Z");

function profile(): BotProfileConfig {
  return {
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
    enabledFunctions: ["save_schedule", "save_memory", "save_resource"],
    permissionRequiredFunctions: ["save_schedule", "save_memory", "save_resource"],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function context(userId = "U1"): FunctionHandlerContext {
  return {
    profile: profile(),
    event: {
      type: "message",
      source: { type: "group", groupId: "G1", userId },
      message: { type: "text", text: "save" }
    },
    requestId: "request-1"
  };
}

describe("helper action review", () => {
  it("maps bounded review lifecycle states to existing product events without arguments", async () => {
    const routeObserver = vi.fn();
    const observe = createActionReviewLifecycleObserver({
      routeObserver,
      requestId: "request-1",
      profileName: "helper",
      source: { type: "group", groupId: "G1", userId: "U1" },
      hmacKey: "observability-key"
    });

    await observe({ status: "approved", action: "save_memory" });
    await observe({ status: "rejected", action: "save_memory" });
    await observe({ status: "expired_or_missing" });
    await observe({ status: "execution_denied", action: "save_memory" });
    await observe({ status: "unavailable", action: "save_memory" });

    expect(routeObserver).toHaveBeenCalledTimes(4);
    expect(routeObserver.mock.calls.map(([event]) => event.finalStatus)).toEqual([
      "review_rejected",
      "review_expired_or_missing",
      "review_execution_denied",
      "review_unavailable"
    ]);
    expect(JSON.stringify(routeObserver.mock.calls)).not.toMatch(/arguments|remember/u);
  });

  it("uses LangGraph HITL and keeps arguments out of LINE postbacks and review state", async () => {
    const args = { content: "schedule content", scheduleType: "service" };
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: "propose_save_schedule", args, id: "call-1" }]]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const checkpointer = new MemorySaver();
    const tools = createHelperWriteTools({
      context: context(),
      executor: createActionExecutor({
        handlers: { save_schedule: vi.fn() },
        authorize: async () => true,
        currentPolicyKey: () => "policy-1"
      })
    });
    const agent = createHelperAgent({
      model,
      summaryModel: model,
      checkpointer,
      tools,
      writeReview: true
    });
    const paused = await agent.invoke(
      { messages: [{ role: "user", content: "save" }] },
      { configurable: { thread_id: "helper-thread" } }
    );
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });

    const result = await createActionReview({
      state: paused,
      sessions,
      jobs,
      profileName: "helper",
      source: context().event.source,
      requesterUserId: "U1",
      threadId: "helper-thread",
      policyKey: "policy-1",
      now: NOW,
      idFactory: () => "review-1",
      resultTtlMs: 60_000,
      preview: async () => "請確認 schedule content"
    });

    expect(result.status).toBe("review");
    expect(result.result?.quickReplies?.[0].action).toMatchObject({ type: "postback" });
    expect(JSON.stringify(result.result?.quickReplies)).not.toContain("schedule content");
    const stored = await sessions.get("review-1");
    expect(stored).toMatchObject({
      type: "action_review",
      profileName: "helper",
      requesterUserId: "U1",
      toolName: "propose_save_schedule",
      argumentsHash: hashReviewArguments(args)
    });
    expect(JSON.stringify(stored)).not.toContain("schedule content");
    expect(JSON.stringify(result.result?.quickReplies)).toContain("resultJobId=");
    if (stored?.type !== "action_review") throw new Error("missing review");
    await expect(
      jobs.get(stored.resultJobId, buildAgentJobScope("helper", context().event.source)!)
    ).resolves.toMatchObject({ expiresAt: "2026-09-04T00:30:00.000Z" });
  });

  it("rejects another group requester without consuming the owner review, then rejects replay", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const resultJob = await jobs.createPending({
      scope: buildAgentJobScope("helper", { type: "group", groupId: "G1", userId: "U1" })!,
      capability: "save_memory",
      label: "action-review",
      ttlMs: 300_000
    });
    await sessions.set({
      id: "review-1",
      type: "action_review",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "G1", userId: "U1" },
      threadId: "thread-1",
      interruptId: "call-1",
      toolName: "propose_save_memory",
      argumentsHash: hashReviewArguments({ content: "remember" }),
      policyKey: "policy-1",
      resultJobId: resultJob.id,
      expiresAt: "2026-09-04T00:05:00.000Z"
    });
    const invoke = vi.fn(async () => ({ messages: [] }));

    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: "review-1",
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U2" },
        requesterUserId: "U2",
        text: "確認",
        agent: { invoke },
        now: NOW
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(await sessions.get("review-1")).toBeDefined();

    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: "review-1",
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U1" },
        requesterUserId: "U1",
        text: "確認",
        agent: { invoke },
        now: NOW,
        getExecutionOutcome: () => ({
          status: "approved",
          result: { ok: true, replyText: "saved", writePhase: "commit" }
        })
      })
    ).resolves.toMatchObject({ status: "approved" });
    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: "review-1",
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U1" },
        requesterUserId: "U1",
        text: "確認",
        agent: { invoke },
        now: NOW
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("does not let another group requester discover the owner's review", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    await sessions.set({
      id: "review-discovery",
      type: "action_review",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "G1", userId: "U1" },
      threadId: "thread-1",
      interruptId: "call-1",
      toolName: "propose_save_memory",
      argumentsHash: "hash",
      policyKey: "policy",
      resultJobId: "job-discovery",
      expiresAt: "2026-09-04T00:05:00.000Z"
    });

    await expect(
      sessions.findActionReview({
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U2" },
        requesterUserId: "U2"
      })
    ).resolves.toBeUndefined();
    await expect(
      sessions.findActionReview({
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ id: "review-discovery" });
  });

  it("never reports approval without an approved executor outcome", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const resultJob = await jobs.createPending({
      scope: buildAgentJobScope("helper", { type: "user", userId: "U1" })!,
      capability: "save_memory",
      label: "action-review",
      ttlMs: 300_000
    });
    const lifecycle = vi.fn();
    await sessions.set({
      id: "review-no-outcome",
      type: "action_review",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      threadId: "thread-1",
      interruptId: "call-1",
      toolName: "propose_save_memory",
      argumentsHash: "hash",
      policyKey: "policy",
      resultJobId: resultJob.id,
      expiresAt: "2026-09-04T00:05:00.000Z"
    });

    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: "review-no-outcome",
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        requesterUserId: "U1",
        text: "確認",
        agent: { invoke: async () => ({ messages: [] }) },
        onLifecycle: lifecycle,
        now: NOW
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(lifecycle).toHaveBeenCalledWith({
      status: "execution_denied",
      action: "save_memory"
    });

    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: "review-no-outcome",
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        requesterUserId: "U1",
        text: "確認",
        agent: { invoke: async () => ({ messages: [] }) },
        onLifecycle: lifecycle,
        now: NOW
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(lifecycle).toHaveBeenLastCalledWith({ status: "expired_or_missing" });
  });

  it.each(["denied", "unavailable"] as const)(
    "does not report approval for an executor %s outcome",
    async (status) => {
      const sessions = new InMemorySessionStore({ now: () => NOW });
      const jobs = new InMemoryAgentJobStore({ now: () => NOW });
      const source = { type: "user" as const, userId: "U1" };
      const resultJob = await jobs.createPending({
        scope: buildAgentJobScope("helper", source)!,
        capability: "save_memory",
        label: "action-review",
        ttlMs: 300_000
      });
      const lifecycle = vi.fn();
      await sessions.set({
        id: `review-${status}`,
        type: "action_review",
        profileName: "helper",
        requesterUserId: "U1",
        source,
        threadId: "thread-1",
        interruptId: "call-1",
        toolName: "propose_save_memory",
        argumentsHash: "hash",
        policyKey: "policy",
        resultJobId: resultJob.id,
        expiresAt: "2026-09-04T00:05:00.000Z"
      });

      await expect(
        resumeHelperReview({
          sessions,
          jobs,
          reviewId: `review-${status}`,
          profileName: "helper",
          source,
          requesterUserId: "U1",
          text: "確認",
          agent: { invoke: async () => ({ messages: [] }) },
          getExecutionOutcome: () => ({ status }),
          onLifecycle: lifecycle,
          now: NOW
        })
      ).resolves.toEqual({ status: "denied" });
      expect(lifecycle).toHaveBeenCalledWith({
        status: status === "unavailable" ? "unavailable" : "execution_denied",
        action: "save_memory"
      });
    }
  );

  it("records a rejected review without executing it", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const resultJob = await jobs.createPending({
      scope: buildAgentJobScope("helper", { type: "user", userId: "U1" })!,
      capability: "save_memory",
      label: "action-review",
      ttlMs: 300_000
    });
    await sessions.set({
      id: "review-reject",
      type: "action_review",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      threadId: "thread-1",
      interruptId: "call-1",
      toolName: "propose_save_memory",
      argumentsHash: "hash",
      policyKey: "policy",
      resultJobId: resultJob.id,
      expiresAt: "2026-09-04T00:05:00.000Z"
    });
    const lifecycle = vi.fn();
    const invoke = vi.fn(async () => ({ messages: [] }));

    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: "review-reject",
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        requesterUserId: "U1",
        text: "取消",
        agent: { invoke },
        onLifecycle: lifecycle,
        now: NOW
      })
    ).resolves.toMatchObject({ status: "rejected" });
    expect(lifecycle).toHaveBeenCalledWith({ status: "rejected", action: "save_memory" });
    expect(
      (await jobs.get(resultJob.id, buildAgentJobScope("helper", { type: "user", userId: "U1" })!))
        ?.status
    ).toBe("failed");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("returns a completed durable result when checkpoint persistence fails after commit", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const source = { type: "user" as const, userId: "U1" };
    const resultJob = await jobs.createPending({
      scope: buildAgentJobScope("helper", source)!,
      capability: "save_memory",
      label: "action-review",
      ttlMs: 30 * 60_000
    });
    await sessions.set({
      id: "review-checkpoint-failure",
      type: "action_review",
      profileName: "helper",
      requesterUserId: "U1",
      source,
      threadId: "thread-1",
      interruptId: "call-1",
      toolName: "propose_save_memory",
      argumentsHash: "hash",
      policyKey: "policy",
      resultJobId: resultJob.id,
      expiresAt: "2026-09-04T00:05:00.000Z"
    });
    const committed = { ok: true, replyText: "已保存", writePhase: "commit" as const };
    const invoke = vi.fn(async () => {
      await jobs.complete(resultJob.id, committed, "save_memory");
      throw new Error("checkpoint persistence failed");
    });

    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: "review-checkpoint-failure",
        profileName: "helper",
        source,
        requesterUserId: "U1",
        text: "確認",
        agent: { invoke },
        now: NOW
      })
    ).resolves.toEqual({ status: "approved", result: committed });
    await expect(
      jobs.get(resultJob.id, buildAgentJobScope("helper", source)!)
    ).resolves.toMatchObject({
      status: "completed",
      result: committed
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("denies changed authorization before execution", async () => {
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const resultJob = await jobs.createPending({
      scope: buildAgentJobScope("helper", context().event.source)!,
      capability: "save_memory",
      label: "action-review",
      ttlMs: 300_000
    });
    const handler = vi.fn(async () => ({
      ok: true,
      replyText: "saved",
      writePhase: "commit" as const
    }));
    const authorize = vi.fn(async () => false);
    const executor = createActionExecutor({
      handlers: { save_schedule: handler },
      authorize,
      currentPolicyKey: () => "policy-2",
      jobs
    });
    const review = {
      id: "review-1",
      type: "action_review" as const,
      profileName: "helper",
      requesterUserId: "U1",
      source: context().event.source,
      interruptId: "call-1",
      toolName: "propose_save_memory" as const,
      argumentsHash: hashReviewArguments({ content: "x" }),
      policyKey: "policy-1",
      resultJobId: resultJob.id,
      expiresAt: "2026-09-04T00:05:00.000Z"
    };

    await expect(
      executor.execute({
        review,
        arguments: { content: "x" },
        context: context()
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("denies changed arguments, policy, and schedule revision before execution", async () => {
    const helperProfile = profile();
    helperProfile.schedulePolicy.domains = DEFAULT_SCHEDULE_DOMAINS.map((domain) =>
      domain.key === "custom_service_schedule" ? { ...domain, revision: "2" } : domain
    );
    const handler = vi.fn(async () => ({
      ok: true,
      replyText: "saved",
      writePhase: "commit" as const
    }));
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const scheduleJob = await jobs.createPending({
      scope: buildAgentJobScope("helper", context().event.source)!,
      capability: "save_schedule",
      label: "action-review",
      ttlMs: 300_000
    });
    const executor = createActionExecutor({
      handlers: { save_schedule: handler, save_memory: handler },
      authorize: async () => true,
      currentPolicyKey: () => "policy-2",
      jobs
    });
    const scheduleReview = {
      id: "review-schedule",
      type: "action_review" as const,
      profileName: "helper",
      requesterUserId: "U1",
      source: context().event.source,
      interruptId: "call-1",
      toolName: "propose_save_schedule" as const,
      argumentsHash: hashReviewArguments({
        content: "x",
        domainKey: "custom_service_schedule",
        domainRevision: "1"
      }),
      policyKey: "policy-2",
      resultJobId: scheduleJob.id,
      expiresAt: "2026-09-04T00:05:00.000Z"
    };
    await expect(
      executor.execute({
        review: scheduleReview,
        arguments: {
          content: "x",
          domainKey: "custom_service_schedule",
          domainRevision: "1"
        },
        context: { ...context(), profile: helperProfile }
      })
    ).resolves.toMatchObject({ status: "denied" });

    const memoryReview = {
      ...scheduleReview,
      toolName: "propose_save_memory" as const,
      argumentsHash: hashReviewArguments({ content: "x" }),
      policyKey: "policy-1",
      resultJobId: (
        await jobs.createPending({
          scope: buildAgentJobScope("helper", context().event.source)!,
          capability: "save_memory",
          label: "action-review",
          ttlMs: 300_000
        })
      ).id
    };
    await expect(
      executor.execute({
        review: memoryReview,
        arguments: { content: "changed" },
        context: context()
      })
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      executor.execute({
        review: memoryReview,
        arguments: { content: "x" },
        context: context()
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("binds the schedule revision in checkpoint arguments and executes an approval once", async () => {
    const helperProfile = profile();
    helperProfile.schedulePolicy.domains = DEFAULT_SCHEDULE_DOMAINS;
    const reviewContext = { ...context(), profile: helperProfile };
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const checkpointer = new MemorySaver();
    let sideEffects = 0;
    const handler = vi.fn(async (args: Record<string, unknown>) => {
      if (args.confirm === true) {
        sideEffects += 1;
        return { ok: true, replyText: "已保存", writePhase: "commit" as const };
      }
      return { ok: true, replyText: "請確認服事表", writePhase: "preview" as const };
    });
    const executor = createActionExecutor({
      handlers: { save_schedule: handler },
      authorize: async () => true,
      currentPolicyKey: () => "policy-1",
      jobs
    });
    const proposed = { content: "2026-09-06 主日 同工甲" };
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: "propose_save_schedule", args: proposed, id: "call-1" }]]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const initialAgent = createHelperAgent({
      model,
      summaryModel: model,
      checkpointer,
      tools: createHelperWriteTools({ context: reviewContext, executor }),
      writeReview: true,
      prepareWriteArguments: (name, args) => executor.prepare(name, args, reviewContext)
    });
    const paused = await initialAgent.invoke(
      { messages: [{ role: "user", content: "保存服事表" }] },
      { configurable: { thread_id: "thread-approve" } }
    );
    const reviewResult = await createActionReview({
      state: paused,
      sessions,
      jobs,
      profileName: "helper",
      source: reviewContext.event.source,
      requesterUserId: "U1",
      threadId: "thread-approve",
      policyKey: "policy-1",
      now: NOW,
      idFactory: () => "review-approve",
      preview: async (toolName, args) =>
        (await executor.preview(toolName, args, reviewContext))?.replyText
    });
    expect(reviewResult.status).toBe("review");
    const review = await sessions.get("review-approve");
    expect(review).toMatchObject({
      type: "action_review",
      argumentsHash: hashReviewArguments({
        ...proposed,
        domainKey: "custom_service_schedule",
        domainRevision: "1",
        scheduleType: "custom_service_schedule"
      })
    });
    if (review?.type !== "action_review") throw new Error("missing review");
    const outcomes: ActionExecution[] = [];
    const resumedAgent = createHelperAgent({
      model,
      summaryModel: model,
      checkpointer,
      tools: createHelperWriteTools({
        context: reviewContext,
        executor,
        review,
        onResult: (outcome) => outcomes.push(outcome)
      }),
      writeReview: true,
      prepareWriteArguments: (name, args) => executor.prepare(name, args, reviewContext)
    });

    await expect(
      resumeHelperReview({
        sessions,
        jobs,
        reviewId: review.id,
        profileName: "helper",
        source: reviewContext.event.source,
        requesterUserId: "U1",
        text: "確認",
        agent: resumedAgent,
        getExecutionOutcome: () => outcomes.at(-1),
        now: NOW
      })
    ).resolves.toMatchObject({
      status: "approved",
      result: { ok: true, replyText: "已保存", writePhase: "commit" }
    });
    expect(outcomes).toEqual([expect.objectContaining({ status: "approved" })]);
    expect(sideEffects).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      confirm: true,
      domainRevision: "1"
    });
    expect(handler.mock.calls[1]?.[1]).toMatchObject({
      requestId: review.interruptId,
      agentTool: true
    });
    const jobScope = buildAgentJobScope("helper", reviewContext.event.source)!;
    const storedJob = await jobs.get(review.resultJobId, jobScope);
    expect(storedJob).toMatchObject({
      status: "completed",
      result: { ok: true, replyText: "已保存", writePhase: "commit" }
    });
  });

  it("creates no review when live authorization rejects the preview", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const result = await createActionReview({
      state: {
        __interrupt__: [
          {
            id: "interrupt-1",
            value: {
              actionRequests: [
                { name: "propose_save_memory", args: { content: "private" }, description: "x" }
              ],
              reviewConfigs: []
            }
          }
        ]
      },
      sessions,
      jobs,
      profileName: "helper",
      source: { type: "user", userId: "U1" },
      requesterUserId: "U1",
      threadId: "thread-1",
      policyKey: "policy-1",
      now: NOW,
      preview: async () => undefined
    });

    expect(result).toEqual({ status: "denied" });
    expect((await sessions.summary()).byType.action_review).toBeUndefined();
  });

  it("normalizes defaults and trimming before checkpoint hashing", () => {
    const executor = createActionExecutor({
      handlers: {},
      authorize: async () => true,
      currentPolicyKey: () => "policy",
      jobs: new InMemoryAgentJobStore({ now: () => NOW })
    });

    expect(
      executor.prepare("propose_save_memory", { query: "  remember this  " }, context())
    ).toEqual({ content: "", query: "remember this" });
    expect(
      executor.prepare(
        "propose_save_resource",
        {
          url: "  https://example.test/file.pdf  ",
          title: "  File  ",
          resourceType: "sheet_music"
        },
        context()
      )
    ).toMatchObject({ url: "https://example.test/file.pdf", title: "File" });
  });

  it("respond invalidates the original review and stores only the revised checkpoint pointer", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const resultJob = await jobs.createPending({
      scope: buildAgentJobScope("helper", { type: "user", userId: "U1" })!,
      capability: "save_memory",
      label: "action-review",
      ttlMs: 300_000
    });
    await sessions.set({
      id: "review-1",
      type: "action_review",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      threadId: "thread-1",
      interruptId: "call-1",
      toolName: "propose_save_memory",
      argumentsHash: hashReviewArguments({ content: "old" }),
      policyKey: "policy-1",
      resultJobId: resultJob.id,
      expiresAt: "2026-09-04T00:05:00.000Z"
    });
    const invoke = vi.fn(async () => ({
      __interrupt__: [
        {
          id: "interrupt-2",
          value: {
            actionRequests: [
              { name: "propose_save_memory", args: { content: "new" }, description: "review" }
            ],
            reviewConfigs: []
          }
        }
      ]
    }));

    const revised = await resumeHelperReview({
      sessions,
      jobs,
      reviewId: "review-1",
      profileName: "helper",
      source: { type: "user", userId: "U1" },
      requesterUserId: "U1",
      text: "改成新的內容",
      agent: { invoke },
      policyKey: "policy-1",
      preview: async () => "new preview",
      idFactory: () => "review-2",
      now: NOW
    });

    expect(revised).toMatchObject({
      status: "review",
      argumentsHash: hashReviewArguments({ content: "new" })
    });
    expect(await sessions.get("review-1")).toBeUndefined();
    expect(await sessions.get("review-2")).toMatchObject({
      type: "action_review",
      argumentsHash: hashReviewArguments({ content: "new" })
    });
    const replacement = await sessions.get("review-2");
    expect(JSON.stringify(replacement)).not.toContain("new");
    expect(replacement?.type === "action_review" && replacement.resultJobId).not.toBe(resultJob.id);
    expect(
      (await jobs.get(resultJob.id, buildAgentJobScope("helper", { type: "user", userId: "U1" })!))
        ?.status
    ).toBe("failed");
  });
});
