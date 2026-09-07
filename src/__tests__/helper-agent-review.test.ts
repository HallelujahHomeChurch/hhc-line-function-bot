import { describe, expect, it, vi } from "vitest";
import { buildAgentJobScope, InMemoryAgentJobStore } from "../agent/jobs.js";
import { createActionReview, hashReviewArguments } from "../helper-agent/review.js";
import { createActionExecutor } from "../runtime/action-executor.js";
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
    schedulePolicy: { meetingReferences: [], domains: [] }
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
  it("keeps exact drafts scoped, binds opaque buttons, and executes a claimed approval once", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const jobs = new InMemoryAgentJobStore({ now: () => NOW });
    const args = { content: "private draft" };
    const result = await createActionReview({
      proposal: { toolName: "propose_save_memory", args, operationId: "operation" },
      sessions,
      jobs,
      profileName: "helper",
      source: context().event.source,
      requesterUserId: "U1",
      threadId: "thread",
      policyKey: "policy",
      now: NOW,
      preview: async () => "預覽"
    });
    expect(result.status).toBe("review");
    if (result.status !== "review") throw new Error("missing review");
    expect(JSON.stringify(result.result.quickReplies)).not.toContain("private draft");
    const wrong = await sessions.takeActionReview({
      id: result.reviewId,
      profileName: "helper",
      source: context("U2").event.source,
      requesterUserId: "U2"
    });
    expect(wrong).toBeUndefined();
    const claimed = await sessions.takeActionReview({
      id: result.reviewId,
      profileName: "helper",
      source: context().event.source,
      requesterUserId: "U1"
    });
    expect(claimed?.draftArguments).toEqual(args);
    expect(claimed?.approvalExpiresAt).toBe("2026-09-04T00:05:00.000Z");
    expect(claimed?.expiresAt).toBe("2026-09-04T00:15:00.000Z");
    if (!claimed) throw new Error("missing claimed draft");
    const handler = vi.fn(async () => ({
      ok: true,
      replyText: "已保存",
      writePhase: "commit" as const
    }));
    const executor = createActionExecutor({
      handlers: { save_memory: handler },
      jobs,
      now: () => NOW,
      authorize: async () => true,
      currentPolicyKey: () => "policy"
    });
    await expect(
      executor.execute({ review: claimed, arguments: args, context: context() })
    ).resolves.toMatchObject({ status: "approved" });
    await expect(
      executor.execute({ review: claimed, arguments: args, context: context() })
    ).resolves.toMatchObject({ status: "denied" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]).toBeDefined();
    await expect(
      sessions.takeActionReview({
        id: result.reviewId,
        profileName: "helper",
        source: context().event.source,
        requesterUserId: "U1"
      })
    ).resolves.toBeUndefined();
    await expect(
      jobs.get(claimed.resultJobId, buildAgentJobScope("helper", context().event.source)!)
    ).resolves.toMatchObject({ status: "completed", result: { replyText: "已保存" } });
  });

  it("creates no draft when authorized preparation cannot produce a preview", async () => {
    const sessions = new InMemorySessionStore({ now: () => NOW });
    const result = await createActionReview({
      proposal: {
        toolName: "propose_save_memory",
        args: { content: "private" },
        operationId: "operation"
      },
      sessions,
      jobs: new InMemoryAgentJobStore({ now: () => NOW }),
      profileName: "helper",
      source: context().event.source,
      requesterUserId: "U1",
      threadId: "thread",
      policyKey: "policy",
      now: NOW,
      preview: async () => undefined
    });
    expect(result).toEqual({ status: "denied" });
    expect((await sessions.summary()).byType.action_review).toBeUndefined();
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
});
