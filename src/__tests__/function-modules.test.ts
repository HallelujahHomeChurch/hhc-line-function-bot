import { describe, expect, it } from "vitest";

import { FUNCTION_NAMES } from "../types.js";
import { FUNCTION_MODULES, getRouterEvalCases } from "../functions/modules.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import {
  createQueryScheduleModule,
  queryScheduleDefinition,
  queryScheduleRouterEvalCases
} from "../capabilities/query-schedule/index.js";

const requiredEvalKinds = [
  "positive",
  "missing_slot",
  "typo",
  "negative",
  "disabled",
  "cross_function"
];

describe("function modules", () => {
  it("has one module for each supported function", () => {
    expect(FUNCTION_MODULES.map((module) => module.name).sort()).toEqual(
      [...FUNCTION_NAMES].sort()
    );
  });

  it("keeps each function module self-contained", () => {
    for (const module of FUNCTION_MODULES) {
      expect(module.definition.name).toBe(module.name);
      expect(module.definition.displayName, module.name).toBeTruthy();
      expect(module.definition.shortDescription, module.name).toBeTruthy();
      expect(module.definition.argumentSchema, module.name).toBeTruthy();
      if (module.definition.sideEffectLevel === "read") {
        expect(module.definition.agentCapability, module.name).toBeTruthy();
      }
      expect(module.routerEvalCases.length, module.name).toBeGreaterThanOrEqual(
        requiredEvalKinds.length
      );
      expect(module.routerEvalCases.map((entry) => entry.kind)).toEqual(
        expect.arrayContaining(requiredEvalKinds)
      );

      for (const entry of module.routerEvalCases) {
        expect(entry.text.trim(), module.name).toBeTruthy();
        expect(entry.expected.type, `${module.name}:${entry.text}`).toMatch(/^(execute|deny)$/);
      }
    }
  });

  it("exposes all executable router eval cases from modules", () => {
    const cases = getRouterEvalCases().filter((entry) => entry.expected.type === "execute");

    expect(cases.map((entry) => entry.expected.action)).toEqual(
      expect.arrayContaining(["find_ppt_slides", "query_schedule", "find_sheet_music"])
    );
    expect(cases.every((entry) => entry.text.trim())).toBe(true);
  });

  it("constructs query_schedule from its narrow explicit dependencies", async () => {
    const module = createQueryScheduleModule({
      memoryStore: new InMemoryAgentMemoryStore()
    });
    const registrations = module.register({} as never);
    const handler = registrations.functions?.query_schedule;

    expect(module.definition).toBe(queryScheduleDefinition);
    expect(module.routerEvalCases).toBe(queryScheduleRouterEvalCases);
    expect(handler).toBeDefined();
    await expect(
      handler?.(
        { query: "列出服事表" },
        {
          profile: {
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
            enabledFunctions: ["query_schedule"]
          },
          event: {
            type: "message",
            source: { type: "user", userId: "U1" },
            message: { type: "text", text: "列出服事表" }
          }
        }
      )
    ).resolves.toMatchObject({ ok: true, replyText: "查不到符合的服事表。" });
  });

  it("rejects query_schedule construction without its required memory port", () => {
    expect(() => createQueryScheduleModule({ memoryStore: undefined } as never)).toThrow(
      "query_schedule requires memoryStore"
    );
  });
});
