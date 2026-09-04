import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import { createHelperAgentState, helperThreadIdleTtlMs } from "../helper-agent/state.js";

const hmacKey = "0123456789abcdef0123456789abcdef";

function testStateOptions(checkpointer: MemorySaver, now?: () => Date) {
  return { checkpointer, hmacKey, now };
}

describe("helper agent state", () => {
  it("uses different idle TTLs without changing requester scope", () => {
    expect(helperThreadIdleTtlMs({ type: "user", userId: "U1" })).toBe(30 * 60_000);
    expect(helperThreadIdleTtlMs({ type: "group", groupId: "G1", userId: "U1" })).toBe(15 * 60_000);
    expect(helperThreadIdleTtlMs({ type: "room", roomId: "R1", userId: "U1" })).toBe(15 * 60_000);
  });

  it("derives isolated opaque threads for profile, source, and requester", () => {
    const state = createHelperAgentState(testStateOptions(new MemorySaver()));
    const first = state.threadId({
      profileName: "helper",
      source: { type: "group", groupId: "G1", userId: "U1" }
    });
    const otherRequester = state.threadId({
      profileName: "helper",
      source: { type: "group", groupId: "G1", userId: "U2" }
    });
    const otherGroup = state.threadId({
      profileName: "helper",
      source: { type: "group", groupId: "G2", userId: "U1" }
    });

    expect(first).toMatch(/^helper-[a-f0-9]{16}$/u);
    expect(new Set([first, otherRequester, otherGroup]).size).toBe(3);
    expect(
      state.threadId({ profileName: "helper", source: { type: "group", groupId: "G1" } })
    ).toBeUndefined();
  });

  it("serializes one thread while allowing a different thread to proceed", async () => {
    const state = createHelperAgentState(testStateOptions(new MemorySaver()));
    const source = { type: "user", userId: "U1" } as const;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = state.run({
      threadId: "helper-a",
      policyKey: "query_schedule",
      source,
      task: async () => {
        order.push("a-start");
        await gate;
        order.push("a-end");
      }
    });
    const second = state.run({
      threadId: "helper-a",
      policyKey: "query_schedule",
      source,
      task: async () => order.push("a-second")
    });
    await state.run({
      threadId: "helper-b",
      policyKey: "query_schedule",
      source,
      task: async () => order.push("b")
    });
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(["a-start", "b", "a-end", "a-second"]);
  });

  it("deletes an expired checkpoint before reuse", async () => {
    let now = new Date("2026-09-04T00:00:00.000Z");
    const checkpointer = new MemorySaver();
    const deleteThread = vi.spyOn(checkpointer, "deleteThread");
    const state = createHelperAgentState(testStateOptions(checkpointer, () => now));
    const input = {
      threadId: "helper-expiring",
      policyKey: "query_schedule",
      source: { type: "group", groupId: "G1", userId: "U1" } as const,
      task: async () => undefined
    };

    await state.run(input);
    now = new Date("2026-09-04T00:16:00.000Z");
    await state.run(input);

    expect(deleteThread).toHaveBeenCalledWith("helper-expiring");
  });

  it("deletes checkpoint evidence when the effective tool set changes", async () => {
    const checkpointer = new MemorySaver();
    const deleteThread = vi.spyOn(checkpointer, "deleteThread");
    const state = createHelperAgentState(testStateOptions(checkpointer));
    const source = { type: "user", userId: "U1" } as const;

    await state.run({
      threadId: "helper-policy",
      policyKey: "one,two",
      source,
      task: async () => undefined
    });
    await state.run({
      threadId: "helper-policy",
      policyKey: "one",
      source,
      task: async () => undefined
    });

    expect(deleteThread).toHaveBeenCalledWith("helper-policy");
  });

  it("expires external sheet-music consent for only its thread", async () => {
    let now = new Date("2026-09-04T00:00:00.000Z");
    const state = createHelperAgentState(testStateOptions(new MemorySaver(), () => now));

    await state.allowExternalSheetMusic(
      "helper-a",
      { type: "group", groupId: "G1", userId: "U1" },
      new Date("2026-09-04T00:01:00.000Z")
    );

    expect(await state.externalSheetMusicAllowed("helper-a")).toBe(true);
    expect(await state.externalSheetMusicAllowed("helper-b")).toBe(false);
    now = new Date("2026-09-04T00:01:00.000Z");
    expect(await state.externalSheetMusicAllowed("helper-a")).toBe(false);
  });

  it("observes expired research consent only after a queued thread lock is acquired", async () => {
    let now = new Date("2026-09-04T00:00:00.000Z");
    const state = createHelperAgentState(testStateOptions(new MemorySaver(), () => now));
    const source = { type: "user", userId: "U1" } as const;
    await state.allowExternalSheetMusic("helper-a", source, new Date("2026-09-04T00:01:00.000Z"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = state.run({
      threadId: "helper-a",
      policyKey: "find_sheet_music",
      source,
      task: async () => gate
    });
    const second = state.run({
      threadId: "helper-a",
      policyKey: "find_sheet_music",
      source,
      task: async (snapshot) => snapshot.externalSheetMusicAllowed
    });

    now = new Date("2026-09-04T00:02:00.000Z");
    release();

    await first;
    await expect(second).resolves.toBe(false);
  });

  it("observes a queued reset before constructing the next turn", async () => {
    const state = createHelperAgentState(testStateOptions(new MemorySaver()));
    const source = { type: "user", userId: "U1" } as const;
    await state.allowExternalSheetMusic("helper-a", source, new Date("2099-09-04T00:01:00.000Z"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = state.run({
      threadId: "helper-a",
      policyKey: "find_sheet_music",
      source,
      task: async () => gate
    });
    const reset = state.reset("helper-a");
    const next = state.run({
      threadId: "helper-a",
      policyKey: "find_sheet_music",
      source,
      task: async (snapshot) => snapshot.externalSheetMusicAllowed
    });

    release();

    await Promise.all([first, reset]);
    await expect(next).resolves.toBe(false);
  });

  it("resets only the current requester thread", async () => {
    const checkpointer = new MemorySaver();
    const deleteThread = vi.spyOn(checkpointer, "deleteThread");
    const state = createHelperAgentState(testStateOptions(checkpointer));

    await state.reset("helper-thread-a");

    expect(deleteThread).toHaveBeenCalledWith("helper-thread-a");
  });
});
