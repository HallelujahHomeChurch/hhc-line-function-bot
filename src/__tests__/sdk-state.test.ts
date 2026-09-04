import { describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

import { createSdkAgentState } from "../agent/sdk-state.js";

describe("SDK agent state", () => {
  it("derives isolated opaque threads for profile, source, and requester", () => {
    const state = createSdkAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "0123456789abcdef0123456789abcdef",
      ttlMs: 600_000
    });

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

    expect(first).toMatch(/^sdk-[a-f0-9]{16}$/u);
    expect(new Set([first, otherRequester, otherGroup]).size).toBe(3);
    expect(
      state.threadId({ profileName: "helper", source: { type: "group", groupId: "G1" } })
    ).toBeUndefined();
  });

  it("serializes one thread while allowing a different thread to proceed", async () => {
    const state = createSdkAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "0123456789abcdef0123456789abcdef",
      ttlMs: 600_000
    });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = state.run("sdk-a", "query_schedule", async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    const second = state.run("sdk-a", "query_schedule", async () => order.push("a-second"));
    await state.run("sdk-b", "query_schedule", async () => order.push("b"));
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(["a-start", "b", "a-end", "a-second"]);
  });

  it("deletes an expired checkpoint before reuse", async () => {
    let now = new Date("2026-09-04T00:00:00.000Z");
    const checkpointer = new MemorySaver();
    const deleteThread = vi.spyOn(checkpointer, "deleteThread");
    const state = createSdkAgentState({
      checkpointer,
      hmacKey: "0123456789abcdef0123456789abcdef",
      now: () => now,
      ttlMs: 1_000
    });

    await state.run("sdk-expiring", "query_schedule", async () => undefined);
    now = new Date("2026-09-04T00:00:02.000Z");
    await state.run("sdk-expiring", "query_schedule", async () => undefined);

    expect(deleteThread).toHaveBeenCalledWith("sdk-expiring");
  });

  it("deletes checkpoint evidence when the effective tool set changes", async () => {
    const checkpointer = new MemorySaver();
    const deleteThread = vi.spyOn(checkpointer, "deleteThread");
    const state = createSdkAgentState({
      checkpointer,
      hmacKey: "0123456789abcdef0123456789abcdef",
      ttlMs: 600_000
    });

    await state.run("sdk-policy", "query_schedule,search_information", async () => undefined);
    await state.run("sdk-policy", "query_schedule", async () => undefined);

    expect(deleteThread).toHaveBeenCalledWith("sdk-policy");
  });
});
