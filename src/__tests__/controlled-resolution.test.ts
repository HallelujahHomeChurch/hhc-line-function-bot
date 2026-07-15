import { describe, expect, it } from "vitest";

import { decideResolution } from "../agent/resolution.js";
import { resolveScheduleDomain } from "../functions/schedule-resolver.js";

describe("controlled resolution", () => {
  const media = {
    id: "media",
    capability: "query_schedule" as const,
    domainKey: "media_team_service",
    displayName: "影視團隊服事",
    evidenceKinds: ["role"],
    requiredSlots: [],
    reference: {}
  };
  const family = {
    id: "family",
    capability: "query_schedule" as const,
    domainKey: "morning_prayer_family",
    displayName: "晨更家族服事",
    evidenceKinds: ["meeting"],
    requiredSlots: [],
    reference: {}
  };

  it("selects one eligible resolver without clarification", () => {
    expect(decideResolution([media])).toMatchObject({
      status: "selected",
      candidate: { id: "media" }
    });
  });

  it("returns domain ambiguity when multiple resolvers remain", () => {
    expect(decideResolution([media, family])).toMatchObject({
      status: "ambiguous",
      candidates: [{ id: "media" }, { id: "family" }]
    });
  });
});

describe("schedule resolver registry", () => {
  it("uses role evidence to select media without treating 晨更 as a domain", () => {
    expect(resolveScheduleDomain({ text: "晨更音控是誰" })).toMatchObject({
      status: "selected",
      candidate: { domainKey: "media_team_service" }
    });
  });

  it("uses participant evidence to select family schedules", () => {
    expect(resolveScheduleDomain({ text: "世緯家園下次服事" })).toMatchObject({
      status: "selected",
      candidate: { domainKey: "morning_prayer_family" }
    });
  });

  it("keeps a generic morning-prayer schedule request ambiguous", () => {
    expect(resolveScheduleDomain({ text: "晨更服事表" })).toMatchObject({ status: "ambiguous" });
  });

  it("resumes the domain stored by the active task", () => {
    expect(
      resolveScheduleDomain({ text: "音控是誰", activeDomainKey: "media_team_service" })
    ).toMatchObject({ status: "selected", candidate: { domainKey: "media_team_service" } });
  });
});
