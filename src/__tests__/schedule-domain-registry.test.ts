import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCHEDULE_DOMAINS,
  resolveScheduleDomain,
  scheduleDomainChoices
} from "../schedules/domain-registry.js";
import { InMemoryScheduleStore } from "../schedules/store.js";

describe("schedule domain registry", () => {
  it("selects domains from declarative aliases and routing hints", () => {
    expect(
      resolveScheduleDomain({ domains: DEFAULT_SCHEDULE_DOMAINS, text: "下一場影視團隊服事" })
    ).toMatchObject({ status: "selected", candidate: { domainKey: "media_team_service" } });
    expect(
      resolveScheduleDomain({ domains: DEFAULT_SCHEDULE_DOMAINS, text: "下一場音控是誰" })
    ).toMatchObject({ status: "selected", candidate: { domainKey: "media_team_service" } });
    expect(
      resolveScheduleDomain({ domains: DEFAULT_SCHEDULE_DOMAINS, text: "下一場兒童主日服事" })
    ).toMatchObject({ status: "selected", candidate: { domainKey: "children_sunday" } });
  });

  it("clarifies when configured evidence matches more than one domain", () => {
    const domains = DEFAULT_SCHEDULE_DOMAINS.map((domain) =>
      domain.key === "children_sunday"
        ? { ...domain, aliases: [...domain.aliases, "共同聚會"] }
        : domain.key === "prayer_meeting_family"
          ? { ...domain, aliases: [...domain.aliases, "共同聚會"] }
          : domain
    );
    expect(resolveScheduleDomain({ domains, text: "查共同聚會服事" })).toMatchObject({
      status: "ambiguous",
      candidates: [{ domainKey: "children_sunday" }, { domainKey: "prayer_meeting_family" }]
    });
  });

  it("prefers the longest explicit alias over a contained generic alias", () => {
    const domains = DEFAULT_SCHEDULE_DOMAINS.map((domain) =>
      domain.key === "custom_service_schedule"
        ? { ...domain, aliases: [...domain.aliases, "主日"] }
        : domain
    );

    expect(resolveScheduleDomain({ domains, text: "下一場兒童主日服事" })).toMatchObject({
      status: "selected",
      candidate: { domainKey: "children_sunday" }
    });
  });

  it("does not let a generic domain routing hint defeat a longer explicit alias", () => {
    const domains = DEFAULT_SCHEDULE_DOMAINS.filter(
      ({ key }) => key === "children_sunday" || key === "custom_service_schedule"
    ).map((domain) =>
      domain.key === "custom_service_schedule"
        ? { ...domain, aliases: [...domain.aliases, "主日"], routingHints: ["音控"] }
        : domain
    );

    expect(resolveScheduleDomain({ domains, text: "兒童主日音控" })).toMatchObject({
      status: "selected",
      candidate: { domainKey: "children_sunday" }
    });
  });

  it("adds future existing-schema domains through data only", () => {
    expect(
      scheduleDomainChoices(DEFAULT_SCHEDULE_DOMAINS).map(({ domainKey }) => domainKey)
    ).toEqual(expect.arrayContaining(["children_sunday", "prayer_meeting_family"]));
  });

  it("keeps the prior schedule snapshot when publication validation fails", async () => {
    const store = new InMemoryScheduleStore();
    await store.publishSnapshot({
      profileName: "helper",
      sourceKey: "media",
      origin: "notion",
      revision: "1",
      publishedAt: "2026-07-20T00:00:00.000Z",
      items: [
        {
          profileName: "helper",
          sourceKey: "media",
          origin: "notion",
          serviceDate: "2026-07-21",
          meeting: "晨更",
          role: "音控",
          assignee: "原同工"
        }
      ]
    });

    await expect(
      store.publishSnapshot({
        profileName: "helper",
        sourceKey: "media",
        origin: "notion",
        revision: "2",
        publishedAt: "2026-07-20T01:00:00.000Z",
        items: [
          {
            profileName: "helper",
            sourceKey: "wrong-source",
            origin: "notion",
            serviceDate: "2026-07-22",
            meeting: "主日",
            role: "音控",
            assignee: "不應出現"
          }
        ]
      })
    ).rejects.toThrow("scope");
    await expect(
      store.searchItems({ profileName: "helper", sourceKeys: ["media"] })
    ).resolves.toEqual([expect.objectContaining({ assignee: "原同工" })]);
  });
});
