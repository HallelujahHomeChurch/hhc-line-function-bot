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

    const activeDocuments = [
      { name: "AGENTS.md", content: agents },
      { name: "README.md", content: readme },
      { name: "docs/architecture-context.md", content: architecture },
      { name: "docs/runbooks/production-operations.md", content: operations }
    ];

    for (const { name, content } of activeDocuments) {
      expect(content, name).toContain("10 19 * * 0");
      expect(content, name).toContain("7 days");
      expect(content, name).toContain("Signature age is warning-only");
      expect(content, name).toMatch(/never an age-based\s+publication block/i);
      expect(content, name).not.toMatch(
        /(?:at-most-)?72-hour|(?:more than |older than )?72 hours(?: old)?/i
      );
      expect(content, name).not.toMatch(
        /signature age is (?:an? )?(?:age-based )?(?:hard stop|(?:publication )?block)\b/i
      );
      expect(content, name).not.toMatch(
        /\bsignature age\b.{0,80}\b(?:hard stop|reject(?:ion)?|fail closed)\b/i
      );
      expect(content, name).not.toMatch(/(?<!never an )\bage-based\s+publication block\b/i);
      expect(content, name).toContain("2 CPU / 4 GiB");
      expect(content, name).not.toMatch(/\b1\s*(?:v\s*)?cpu\s*\/\s*4\s*gi\s*b\b/i);
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
