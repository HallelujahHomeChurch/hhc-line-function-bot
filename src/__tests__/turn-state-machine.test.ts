import { describe, expect, it } from "vitest";

import { orderTurnHandlers } from "../agent/turn-state-machine.js";
import type { TextContinuationStage, TextMessageHandler } from "../types.js";

function handler(turnStage: TextContinuationStage): TextMessageHandler {
  return {
    turnStage,
    matches: () => false,
    handle: async () => undefined
  };
}

describe("text continuation order", () => {
  it("orders pending workflows by authority and preserves registration order within a stage", () => {
    const ordered = orderTurnHandlers({
      recall: handler("pre_route_recall"),
      attachment: handler("attachment"),
      secondSelection: handler("resolution"),
      firstSelection: handler("resolution"),
      pending: handler("pending_function")
    });

    expect(ordered.map(({ name }) => name)).toEqual([
      "pending",
      "secondSelection",
      "firstSelection",
      "attachment",
      "recall"
    ]);
  });
});
