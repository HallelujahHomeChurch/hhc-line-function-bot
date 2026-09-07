import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createEvalProbe,
  createSyntheticRuntimeFixture,
  instrumentedFakeModel
} from "../evals/synthetic-runtime-fixture.js";
import { helperSystemPrompt } from "../helper-agent/runtime.js";

it("uses checked-in policies for live-compatible fixtures while retaining synthetic identities", () => {
  const probe = createEvalProbe();
  const fixture = createSyntheticRuntimeFixture({
    model: instrumentedFakeModel([[]], probe),
    probe,
    enabledFunctions: ["save_schedule"],
    useCheckedInPolicy: true
  });
  expect(fixture.profile.agent?.personaPrompt).toBe(
    readFileSync("config/agents/helper/PERSONA.md", "utf8").trim()
  );
  expect(fixture.profile.agent?.memoryPolicyPrompt).toBe(
    readFileSync("config/agents/helper/MEMORY.md", "utf8").trim()
  );
  expect(fixture.profile.channelSecret).toBe("synthetic-secret");
  expect(fixture.profile.enabledFunctions).toEqual(["save_schedule"]);
});

describe("draft evidence policy", () => {
  it("allows user-authored draft input without claiming it is verified official data", () => {
    const probe = createEvalProbe();
    const fixture = createSyntheticRuntimeFixture({
      model: instrumentedFakeModel([[]], probe),
      probe,
      enabledFunctions: ["save_schedule"]
    });
    expect(helperSystemPrompt(fixture.profile, fixture.source, new Date())).toContain(
      "使用者明確提供的內容可作為待確認草稿來源"
    );
  });
});

it("rejects schedule visibility and accepts raw supplied rows without invented optional fields", async () => {
  const { saveScheduleAgentArgumentsSchema } = await import("../function-arguments.js");
  expect(
    saveScheduleAgentArgumentsSchema.safeParse({
      content: "晨更服事表\n9/13 合成甲組",
      visibility: "private"
    }).success
  ).toBe(false);
  const parsed = saveScheduleAgentArgumentsSchema.parse({ content: "晨更服事表\n9/13 合成甲組" });
  expect(parsed).toEqual({ content: "晨更服事表\n9/13 合成甲組" });
});

it("previews raw content-only schedule input through server-owned domain defaults", async () => {
  const { createSaveScheduleHandler } = await import("../functions/schedule-memory.js");
  const { DEFAULT_SCHEDULE_DOMAINS } = await import("../schedules/domain-registry.js");
  const { InMemoryAgentMemoryStore } = await import("../agent/memory-store.js");
  const now = () => new Date("2026-09-04T00:00:00.000Z");
  const memoryStore = new InMemoryAgentMemoryStore({ now });
  const probe = createEvalProbe();
  const app = createSyntheticRuntimeFixture({
    model: instrumentedFakeModel(
      [
        [
          {
            name: "propose_save_schedule",
            args: { content: "晨更服事表\n9/13 合成甲組" },
            id: "raw-content"
          }
        ],
        []
      ],
      probe
    ),
    probe,
    enabledFunctions: ["save_schedule"],
    handlers: { save_schedule: createSaveScheduleHandler({ memoryStore, now }) },
    profile: {
      schedulePolicy: {
        meetingReferences: [],
        domains: DEFAULT_SCHEDULE_DOMAINS.filter(({ key }) => key === "morning_prayer_family")
      }
    },
    now
  });
  const preview = await app.runtime.handleTextTurn(app.turn("請保存 9/13 合成甲組"));
  expect(preview?.writePhase).toBe("preview");
  expect(await memoryStore.listScheduleMemories({ profileName: "helper" })).toEqual([]);
  const review = await app.sessions.findActionReview({
    profileName: "helper",
    source: app.source,
    requesterUserId: app.source.userId!
  });
  expect(review?.draftArguments).toMatchObject({
    content: "晨更服事表\n9/13 合成甲組",
    domainKey: "morning_prayer_family"
  });
  expect(review?.draftArguments).not.toHaveProperty("visibility");
  expect(review?.draftArguments).not.toHaveProperty("entry");
});
