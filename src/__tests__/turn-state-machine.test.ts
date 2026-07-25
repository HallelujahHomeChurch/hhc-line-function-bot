import { describe, expect, it } from "vitest";

import { orderTurnHandlers } from "../agent/turn-state-machine.js";
import { runTurnStages } from "../application/turn/coordinator.js";
import type { TurnStage } from "../application/turn/contracts.js";
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

  it("runs application stages in security-sensitive precedence order", async () => {
    const calls: string[] = [];
    const stages = [
      stage("function_execution", calls),
      stage("controlled_plan", calls),
      stage("admin_action", calls),
      stage("capability_resolution", calls),
      stage("text_continuation", calls)
    ];

    await runTurnStages(stages, {});

    expect(calls).toEqual([
      "text_continuation",
      "capability_resolution",
      "admin_action",
      "controlled_plan",
      "function_execution"
    ]);
  });

  it("does not run lower-authority stages after a stage handles the turn", async () => {
    const calls: string[] = [];
    const stages = [
      stage("text_continuation", calls),
      stage("capability_resolution", calls, "handled"),
      stage("admin_action", calls),
      stage("controlled_plan", calls)
    ];

    const result = await runTurnStages(stages, {});

    expect(result).toEqual({ kind: "handled", result: "done" });
    expect(calls).toEqual(["text_continuation", "capability_resolution"]);
  });
});

function stage(
  name: TurnStage<object, string>["name"],
  calls: string[],
  outcome: "continue" | "handled" = "continue"
): TurnStage<object, string> {
  return {
    name,
    async run() {
      calls.push(name);
      return outcome === "handled" ? { kind: "handled", result: "done" } : { kind: "continue" };
    }
  };
}
