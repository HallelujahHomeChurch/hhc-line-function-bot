import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const documents = ["AGENTS.md", "README.md", "docs/architecture-context.md"];

describe("helper agent operational documentation", () => {
  it("points to the final profile runtimes and helper boundaries", async () => {
    const text = (await Promise.all(documents.map((path) => readFile(path, "utf8")))).join("\n");

    for (const path of [
      "src/runtime/profile-runtime.ts",
      "src/runtime/main-runtime.ts",
      "src/helper-agent/runtime.ts",
      "src/helper-agent/state.ts",
      "src/helper-agent/policy-gateway.ts",
      "src/runtime/action-executor.ts",
      "src/transport/line/attachment-intake.ts"
    ]) {
      expect(text).toContain(path);
    }
    expect(text).toContain("pnpm eval:sdk-agent --live");
  });

  it("does not direct maintainers to retired orchestration", async () => {
    const text = (await Promise.all(documents.map((path) => readFile(path, "utf8")))).join("\n");

    for (const retired of [
      "src/agent/sdk-runtime.ts",
      "src/agent/sdk-turn-runtime.ts",
      "src/agent/sdk-tools.ts",
      "src/agent/sdk-state.ts",
      "src/application/turn/runtime.ts",
      "src/functions/definitions.ts",
      "src/functions/modules.ts",
      "src/functions/registry.ts",
      "src/agent/slot-clarification.ts",
      "src/functions/pending-resolution.ts"
    ]) {
      expect(text).not.toContain(retired);
    }
  });
});
