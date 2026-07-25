import { describe, expect, it } from "vitest";

import { createProviderBudget } from "../evals/kernel/local-live/budget.js";
import {
  KERNEL_LOCAL_LIVE_CASES,
  selectKernelLocalLiveCases,
  validateKernelLocalLiveCost
} from "../evals/kernel/local-live/cases.js";

describe("Kernel local live case costs", () => {
  it("rejects a suite whose declared provider ceiling exceeds the authority limit", () => {
    expect(validateKernelLocalLiveCost(KERNEL_LOCAL_LIVE_CASES)).toEqual({
      deepSeekMax: 10,
      embeddingBatchMax: 3
    });

    expect(() =>
      validateKernelLocalLiveCost([
        ...KERNEL_LOCAL_LIVE_CASES,
        {
          id: "over-budget",
          version: 1,
          journey: "schedule_explicit",
          deepSeekMax: 1,
          embeddingBatchMax: 0
        }
      ])
    ).toThrow("kernel_local_live_cost_exceeded");
  });

  it("selects only a declared case and rejects unknown case IDs", () => {
    expect(selectKernelLocalLiveCases("schedule-explicit").map(({ id }) => id)).toEqual([
      "schedule-explicit"
    ]);
    expect(() => selectKernelLocalLiveCases("missing-case")).toThrow(
      "kernel_local_live_case_unknown"
    );
  });

  it("declares the complete fixed suite without duplicate or mutable entries", () => {
    expect(
      KERNEL_LOCAL_LIVE_CASES.map(({ id, deepSeekMax, embeddingBatchMax }) => [
        id,
        deepSeekMax,
        embeddingBatchMax
      ])
    ).toEqual([
      ["schedule-explicit", 1, 0],
      ["schedule-refinement", 2, 0],
      ["schedule-ambiguity", 1, 0],
      ["capability-switch", 2, 0],
      ["knowledge-follow-up", 2, 3],
      ["group-requester-isolation", 1, 0],
      ["provider-unavailable", 0, 0],
      ["write-preview-confirm", 1, 0]
    ]);
    expect(Object.isFrozen(KERNEL_LOCAL_LIVE_CASES)).toBe(true);
    expect(KERNEL_LOCAL_LIVE_CASES.every(Object.isFrozen)).toBe(true);
  });
});

describe("Kernel local live provider budget", () => {
  it("increments before dispatch and records a failed call without retrying it", async () => {
    let attempts = 0;
    const budget = createProviderBudget({ deepSeekMax: 1, embeddingBatchMax: 0 });

    await expect(
      budget.runDeepSeek("schedule-explicit", async () => {
        attempts += 1;
        throw new Error("provider_call_failed");
      })
    ).rejects.toThrow("provider_call_failed");

    expect(attempts).toBe(1);
    expect(budget.snapshot()).toEqual({
      deepSeekRequests: 1,
      embeddingBatches: 0,
      observations: [
        {
          provider: "deepseek",
          caseId: "schedule-explicit",
          ordinal: 1,
          outcome: "failed"
        }
      ]
    });
  });

  it("rejects an outbound call that would exceed either provider ceiling", async () => {
    const budget = createProviderBudget({ deepSeekMax: 1, embeddingBatchMax: 1 });

    await budget.runDeepSeek("schedule-explicit", async () => "first");
    await expect(budget.runDeepSeek("schedule-explicit", async () => "second")).rejects.toThrow(
      "kernel_local_live_deepseek_budget_exhausted"
    );

    await budget.runEmbedding("knowledge-follow-up", async () => "first");
    await expect(budget.runEmbedding("knowledge-follow-up", async () => "second")).rejects.toThrow(
      "kernel_local_live_embedding_budget_exhausted"
    );
  });

  it("serializes provider calls across both live providers", async () => {
    const budget = createProviderBudget({ deepSeekMax: 1, embeddingBatchMax: 1 });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = budget.runDeepSeek("schedule-explicit", async () => {
      order.push("deepseek:start");
      await firstCanFinish;
      order.push("deepseek:end");
    });
    const second = budget.runEmbedding("knowledge-follow-up", async () => {
      order.push("embedding:start");
      order.push("embedding:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["deepseek:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["deepseek:start", "deepseek:end", "embedding:start", "embedding:end"]);
  });
});
