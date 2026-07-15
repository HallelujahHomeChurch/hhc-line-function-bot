import { describe, expect, it } from "vitest";

import {
  createCapabilityResolution,
  resumeCapabilityResolution
} from "../agent/capability-resolution.js";
import { InMemorySessionStore } from "../state/session-store.js";

const now = new Date("2026-07-16T12:00:00.000Z");
const source = { type: "group" as const, groupId: "group-1", userId: "user-1" };

describe("capability resolution", () => {
  it("stores a bounded choice and resumes the original request", async () => {
    const store = new InMemorySessionStore({ now: () => now });
    const reply = await createCapabilityResolution({
      sessionStore: store,
      id: "resolution-1",
      profileName: "helper",
      source,
      requesterUserId: "user-1",
      originalText: "晨更服事表",
      candidates: ["query_schedule", "retrieve_memory"],
      now
    });

    expect(reply?.quickReplies?.map(({ label }) => label)).toEqual(["查服事表", "查記住的資訊"]);
    await expect(
      resumeCapabilityResolution({
        sessionStore: store,
        profileName: "helper",
        source,
        requesterUserId: "user-1",
        text: "2",
        enabledFunctions: ["query_schedule", "retrieve_memory"]
      })
    ).resolves.toEqual({
      kind: "selected",
      capability: "retrieve_memory",
      originalText: "晨更服事表"
    });
  });

  it("does not let another group requester consume the choice", async () => {
    const store = new InMemorySessionStore({ now: () => now });
    await createCapabilityResolution({
      sessionStore: store,
      id: "resolution-1",
      profileName: "helper",
      source,
      requesterUserId: "user-1",
      originalText: "晨更服事表",
      candidates: ["query_schedule", "retrieve_memory"],
      now
    });

    await expect(
      resumeCapabilityResolution({
        sessionStore: store,
        profileName: "helper",
        source: { ...source, userId: "user-2" },
        requesterUserId: "user-2",
        text: "查服事表",
        enabledFunctions: ["query_schedule", "retrieve_memory"]
      })
    ).resolves.toEqual({ kind: "none" });
  });
});
