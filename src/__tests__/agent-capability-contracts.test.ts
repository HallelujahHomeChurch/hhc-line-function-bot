import { describe, expect, it } from "vitest";

import { createHelperReadTools } from "../helper-agent/read-tools.js";
import { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
import type { FunctionRegistry } from "../types.js";

const readDefinitions = CAPABILITY_CATALOG.filter(
  ({ sideEffectLevel }) => sideEffectLevel === "read"
);

describe("helper agent capability contracts", () => {
  it("gives every read function a strict schema and model-facing description", () => {
    expect(readDefinitions.length).toBeGreaterThan(0);
    for (const definition of readDefinitions) {
      expect(typeof definition.argumentSchema.safeParse, definition.name).toBe("function");
      expect(definition.agentCapability?.semanticDescription, definition.name).toBeTruthy();
    }
  });

  it("exposes only enabled, registered helper tools", () => {
    const enabledFunctions = ["query_schedule", "query_wikipedia"] as const;
    const functionRegistry = Object.fromEntries(
      enabledFunctions.map((name) => [name, async () => ({ ok: true, replyText: "ok" })])
    ) as FunctionRegistry;
    const tools = createHelperReadTools({
      context: {
        profile: {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          allowDirectUser: true,
          allowRooms: false,
          allowedMessageTypes: ["text"],
          groupRequireWakeWord: false,
          wakeKeywords: [],
          acceptMention: true,
          enabledFunctions: [...enabledFunctions],
          permissionRequiredFunctions: []
        },
        event: {
          type: "message",
          source: { type: "user", userId: "U1" },
          message: { type: "text", text: "查詢" }
        }
      },
      handlers: functionRegistry
    });

    expect(tools.map(({ name }) => name)).toEqual(["get_official_schedule", "query_wikipedia"]);
  });
});
