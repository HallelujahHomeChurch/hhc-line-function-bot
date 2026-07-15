import { describe, expect, it } from "vitest";

import { orderTurnHandlers } from "../agent/turn-state-machine.js";
import type { ControlledTurnStage, TextMessageHandler } from "../types.js";

function handler(turnStage: ControlledTurnStage): TextMessageHandler {
  return {
    turnStage,
    matches: () => false,
    handle: async () => undefined
  };
}

describe("controlled turn state machine", () => {
  it("orders claims by workflow authority instead of registration order", () => {
    const ordered = orderTurnHandlers({
      recall: handler("pre_route_recall"),
      attachment: handler("attachment"),
      selection: handler("resolution"),
      pending: handler("pending_function")
    });

    expect(ordered.map(({ name }) => name)).toEqual([
      "pending",
      "selection",
      "attachment",
      "recall"
    ]);
  });

  it("preserves registration order only within the same declared stage", () => {
    const ordered = orderTurnHandlers({
      second: handler("resolution"),
      first: handler("resolution")
    });

    expect(ordered.map(({ name }) => name)).toEqual(["second", "first"]);
  });
});
