import { describe, expect, it, vi } from "vitest";

import { createHelperReadTools } from "../helper-agent/read-tools.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  LineSource
} from "../types.js";

const allReadFunctions: FunctionName[] = [
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

  it("exposes no tools outside the helper profile or for an anonymous group requester", () => {
    const main = context();
    main.profile = { ...main.profile, name: "main", allowedProviders: [] };

    expect(createHelperReadTools({ context: main, handlers: registry() })).toEqual([]);
    expect(
      createHelperReadTools({
        context: context(allReadFunctions, { type: "group", groupId: "G1" }),
        handlers: registry()
      })
    ).toEqual([]);
  });
});
