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
    const [readme, agents, architecture, operations] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("AGENTS.md", "utf8"),
      readFile("docs/architecture-context.md", "utf8"),
      readFile("docs/runbooks/production-operations.md", "utf8")
    ]);

    for (const document of [readme, agents, architecture, operations]) {
      expect(document).toContain("10 19 * * 0");
      expect(document).toContain("7 days");
      expect(document).not.toMatch(
        /(?:at-most-)?72-hour|(?:more than |older than )?72 hours(?: old)?/i
      );
    }

    for (const document of [readme, agents, architecture, operations]) {
      expect(document).toContain("2 CPU / 4 GiB");
      expect(document).not.toContain("1 vCPU/4 GiB");
    }

    expect(readme).toContain("signatureHealth");
    expect(readme).toContain("warning-only");
    expect(readme).toContain("manifest-driven");
    expect(readme).toContain("scripts/deploy-aca.sh");
    expect(architecture).toContain("pure signature policy");
    expect(architecture).toContain("pre-scan");
    expect(architecture).toContain("pre-publication");
    expect(operations).toContain("warning");
  });
});
