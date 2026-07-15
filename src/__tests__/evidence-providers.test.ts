import { describe, expect, it } from "vitest";

import {
  createCatalogEvidenceProvider,
  createMemoryEvidenceProvider,
  createScheduleEvidenceProvider
} from "../agent/evidence/providers.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";

const storage = {
  provider: "graph" as const,
  driveId: "drive-1",
  itemId: "item-1"
};

describe("contract evidence providers", () => {
  it("finds catalog evidence while returning opaque identifiers only", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "ppt_slides",
      adapterType: "onedrive",
      domain: "presentation",
      defaultItemKind: "ppt_slide",
      rootLocation: {},
      enabled: true,
      syncPolicy: { mode: "manual" },
      capabilities: { read: ["helper"], write: [] }
    });
    const item = await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "主日報告投影片",
      storageRef: storage
    });
    const provider = createCatalogEvidenceProvider(catalog, {
      domains: ["presentation"],
      itemKinds: ["ppt_slide"]
    });

    const result = await provider.probe({
      profileName: "helper",
      text: "主日報告",
      source: "group",
      sourceId: "group-1",
      requesterUserId: "user-1",
      maxResults: 5
    });

    expect(result).toEqual({ matched: true, count: 1, opaqueIds: [item.id] });
    expect(JSON.stringify(result)).not.toContain("主日報告投影片");
  });

  it("keeps text-memory evidence requester scoped in groups", async () => {
    const memories = new InMemoryAgentMemoryStore();
    await memories.saveTextMemory({
      profileName: "helper",
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      createdBy: "user-1",
      visibility: "private",
      content: "器材室鑰匙放在行政桌抽屜"
    });
    const provider = createMemoryEvidenceProvider(memories);
    const input = {
      profileName: "helper",
      text: "器材室鑰匙",
      source: "group" as const,
      sourceId: "group-1",
      maxResults: 5
    };

    await expect(provider.probe({ ...input, requesterUserId: "user-2" })).resolves.toEqual({
      matched: false,
      count: 0,
      opaqueIds: []
    });
    await expect(provider.probe({ ...input, requesterUserId: "user-1" })).resolves.toMatchObject({
      matched: true,
      count: 1
    });
  });

  it("finds structured schedule evidence without exposing assignees", async () => {
    const memories = new InMemoryAgentMemoryStore();
    await memories.saveScheduleMemory({
      profileName: "helper",
      source: { type: "user", userId: "admin-1" },
      createdBy: "admin-1",
      scheduleType: "morning_prayer_family",
      title: "七月晨更服事",
      originalText: "7/21 晨更 黃弘家族1",
      entries: [
        {
          serviceDate: "2026-07-21",
          meetingName: "晨更",
          role: "家族",
          assignee: "黃弘家族1"
        }
      ]
    });
    const provider = createScheduleEvidenceProvider(memories);

    const result = await provider.probe({
      profileName: "helper",
      text: "7/21 晨更",
      source: "user",
      sourceId: "user-1",
      requesterUserId: "user-1",
      maxResults: 5
    });

    expect(result.matched).toBe(true);
    expect(result.count).toBe(1);
    expect(JSON.stringify(result)).not.toContain("黃弘");
  });
});
