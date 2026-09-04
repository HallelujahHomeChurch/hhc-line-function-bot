import type { CapabilityName } from "../capabilities/names.js";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { createHelperReadTools } from "../helper-agent/read-tools.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  FunctionRegistry,
  LineSource
} from "../types.js";

const allReadFunctions: CapabilityName[] = [
  "query_schedule",
  "find_ppt_slides",
  "find_sheet_music",
  "find_resource",
  "query_knowledge",
  "retrieve_memory",
  "query_wikipedia"
];

function profile(enabledFunctions = allReadFunctions): BotProfileConfig {
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
    enabledFunctions,
    permissionRequiredFunctions: [],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function context(
  enabledFunctions = allReadFunctions,
  source: LineSource = { type: "user", userId: "U1" }
): FunctionHandlerContext {
  return {
    profile: profile(enabledFunctions),
    event: { type: "message", source, message: { type: "text", text: "查服事表" } }
  };
}

function registry(): FunctionRegistry {
  return Object.fromEntries(
    allReadFunctions.map((name) => [
      name,
      vi.fn(async () => ({
        ok: true,
        replyText: "done",
        agentResult: {
          status: "success" as const,
          replyText: "done",
          replyData: { kind: name, fields: { result: "done" } }
        }
      }))
    ])
  );
}

describe("helper read tools", () => {
  it("exposes seven separate authority-specific tools", () => {
    const names = createHelperReadTools({ context: context(), handlers: registry() }).map(
      ({ name }) => name
    );

    expect(names).toEqual([
      "get_official_schedule",
      "find_presentation",
      "find_sheet_music",
      "find_resource",
      "search_knowledge",
      "search_saved_notes",
      "query_wikipedia"
    ]);
    expect(names).not.toContain("search_information");
    expect(names).not.toContain("search_files");
  });

  it("does not expose disabled, unregistered, or source-invalid tools", () => {
    const handlers = registry();

    expect(
      createHelperReadTools({
        context: context(["query_schedule"], { type: "group", groupId: "G1", userId: "U1" }),
        handlers
      }).map(({ name }) => name)
    ).toEqual(["get_official_schedule"]);
    expect(createHelperReadTools({ context: context(["query_schedule"]), handlers: {} })).toEqual(
      []
    );
    expect(
      createHelperReadTools({
        context: context(["query_schedule"], { type: "room", roomId: "R1", userId: "U1" }),
        handlers
      })
    ).toEqual([]);
  });

  it("keeps authority explicit and lets the schedule domain default an omitted period", async () => {
    const handlers = registry();
    const tools = createHelperReadTools({ context: context(), handlers });

    await expect(
      tools.find(({ name }) => name === "get_official_schedule")?.invoke({ query: "查服事表" })
    ).resolves.toMatchObject({ status: "success", sourceType: "official" });
    await expect(
      tools.find(({ name }) => name === "search_saved_notes")?.invoke({ query: "服事表" })
    ).resolves.toMatchObject({ status: "success", sourceType: "saved_note" });
    expect(handlers.query_schedule).toHaveBeenCalledWith(
      { query: "查服事表" },
      expect.objectContaining({ agentTool: true })
    );
  });

  it("returns a bounded official schedule list without internal source data", async () => {
    const now = () => new Date("2026-09-04T00:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now });
    for (let index = 1; index <= 12; index += 1) {
      await memoryStore.saveScheduleMemory({
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        scheduleType: `schedule_${index}`,
        title: `服事表 ${index}`,
        originalText: `2026-09-${String(index).padStart(2, "0")} 服事安排`,
        entries: [
          {
            serviceDate: `2026-09-${String(index).padStart(2, "0")}`,
            meetingName: "聚會",
            role: "服事",
            assignee: "同工"
          }
        ]
      });
    }
    const [schedule] = createHelperReadTools({
      context: context(["query_schedule"]),
      handlers: {
        query_schedule: createQueryScheduleHandler({ memoryStore, now, timeZone: "Asia/Taipei" })
      }
    });

    const result = await schedule?.invoke({ query: "有哪些服事表" });

    expect(result).toMatchObject({
      status: "success",
      sourceType: "official",
      data: { kind: "schedule_list", records: expect.any(Array) }
    });
    expect((result as { data: { records: unknown[] } }).data.records).toHaveLength(10);
    expect(JSON.stringify(result)).toContain("服事表");
    expect(JSON.stringify(result)).not.toMatch(/memoryId|sourceKey|userId|U1/u);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2_000);
  });

  it("rechecks live authorization through the shared gateway", async () => {
    const handlers = registry();
    const authorize = vi.fn(async () => false);
    const [schedule] = createHelperReadTools({ context: context(), handlers, authorize });

    await expect(schedule?.invoke({ query: "查服事表" })).resolves.toEqual({
      status: "denied",
      sourceType: "official"
    });
    expect(authorize).toHaveBeenCalledWith("query_schedule");
    expect(handlers.query_schedule).not.toHaveBeenCalled();
  });

  it("hides a restricted read when no live authorizer is available", () => {
    const restricted = context(["query_schedule"]);
    restricted.profile.permissionRequiredFunctions = ["query_schedule"];

    expect(createHelperReadTools({ context: restricted, handlers: registry() })).toEqual([]);
  });

  it("exposes no tools outside the helper profile or without a requester identity", () => {
    const main = context();
    main.profile = { ...main.profile, name: "main", allowedProviders: [] };

    expect(createHelperReadTools({ context: main, handlers: registry() })).toEqual([]);
    expect(
      createHelperReadTools({
        context: context(allReadFunctions, { type: "user" }),
        handlers: registry()
      })
    ).toEqual([]);
    expect(
      createHelperReadTools({
        context: context(allReadFunctions, { type: "group", groupId: "G1" }),
        handlers: registry()
      })
    ).toEqual([]);
  });
});
