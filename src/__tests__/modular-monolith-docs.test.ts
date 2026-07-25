import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("R3.5 modular monolith documentation", () => {
  it("documents the composition root, dependency direction, and capability ownership", async () => {
    const architecture = await readFile("docs/architecture-context.md", "utf8");

    expect(architecture).toContain("src/bootstrap/");
    expect(architecture).toContain("src/transport/");
    expect(architecture).toContain("src/application/");
    expect(architecture).toContain("src/capabilities/");
    expect(architecture).toContain("query_schedule");
  });

  it("keeps the weekly ClamAV refresh ownership aligned across operator docs", async () => {
    const [readme, agents] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("AGENTS.md", "utf8")
    ]);

    expect(readme).toContain("10 19 * * 0");
    expect(agents).toContain("10 19 * * 0");
    expect(agents).not.toContain("10 19 */2 * *");
  });
});
