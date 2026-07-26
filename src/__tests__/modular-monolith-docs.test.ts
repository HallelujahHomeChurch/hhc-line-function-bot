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

  it("marks the old roadmap as historical and keeps final R4.0 guidance current", async () => {
    const [legacyRoadmap, currentRoadmap, implementationPlan, readme] = await Promise.all([
      readFile(
        "docs/superpowers/specs/2026-07-19-controlled-retrieval-product-roadmap-design.md",
        "utf8"
      ),
      readFile(
        "docs/superpowers/specs/2026-07-26-single-church-optimization-roadmap-design.md",
        "utf8"
      ),
      readFile("docs/superpowers/plans/2026-07-26-r4-0-production-contract-correction.md", "utf8"),
      readFile("README.md", "utf8")
    ]);
    const legacyBanner = legacyRoadmap.slice(0, legacyRoadmap.indexOf("## Status"));

    expect(legacyBanner).toContain("Superseded");
    expect(legacyBanner).toContain("all remaining R4-R8 direction");
    expect(legacyBanner).toContain("completed milestones remain historical");
    expect(legacyBanner).toContain("2026-07-26-single-church-optimization-roadmap-design.md");
    expect(legacyRoadmap).toContain(
      "Historical baseline approved on 2026-07-19; remaining direction superseded on 2026-07-26."
    );
    expect(currentRoadmap).toContain("This design replaces the remaining R4 through R8 direction");
    expect(currentRoadmap).toContain("-> Completed R4.1 Production Verification");
    expect(currentRoadmap).not.toContain("-> Completed R4.1 Internal Product Experience");

    expect(implementationPlan).not.toContain("// prettier-ignore");
    expect(implementationPlan).toContain(`const expectedEnvironment = {
  signaturePolicy: {
    warningAgeMs: 168 * 60 * 60 * 1000
  }
};`);
    expect(implementationPlan).toContain(
      "The next roadmap milestone is R4.1 Internal Product Experience."
    );
    expect(implementationPlan).not.toContain(
      "The next roadmap milestone is R5.1 operational hardening"
    );

    expect(readme).toContain("owns environment-specific values");
    expect(readme).toContain("applies and verifies Dapr configuration");
  });
});

describe("R5.0 release-assurance documentation", () => {
  it("keeps the final roadmap state and operational evidence boundaries explicit", async () => {
    const [readme, agents, architecture, operations, roadmap] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("AGENTS.md", "utf8"),
      readFile("docs/architecture-context.md", "utf8"),
      readFile("docs/runbooks/production-operations.md", "utf8"),
      readFile(
        "docs/superpowers/specs/2026-07-26-single-church-optimization-roadmap-design.md",
        "utf8"
      )
    ]);

    expect(roadmap).toContain("R4.1 production verification is complete.");
    expect(roadmap).toMatch(
      /R5\.0 implementation is complete; PR CI,\s+production release acceptance, and the first periodic assurance run remain\s+pending\./
    );
    expect(roadmap).toContain("Stable Maintenance is the only successor to R5.0.");
    expect(roadmap).toMatch(/No R5\.1\/R5\.2, SaaS,\s+or local-model follow-up is planned\./);

    expect(operations).toContain("hhc-line-bot-release-probe");
    expect(operations).toContain("artifacts/release-assurance/report.json");
    expect(operations).toContain("hhc-line-bot-periodic-assurance");
    expect(operations).toContain("artifacts/release-assurance/periodic-report.json");
    expect(operations).toContain("az containerapp revision copy");
    expect(operations).toContain("--from-revision");
    expect(operations).toContain("providerRequests: { deepseek: 0, embedding: 0 }");
    expect(operations).toContain("does not prove LINE delivery or reply-token behavior");

    for (const [name, content] of [
      ["README.md", readme],
      ["AGENTS.md", agents],
      ["docs/architecture-context.md", architecture],
      ["docs/runbooks/production-operations.md", operations]
    ]) {
      expect(content, name).toContain("R5.0");
      expect(content, name).toContain("Stable Maintenance");
    }
  });
});
