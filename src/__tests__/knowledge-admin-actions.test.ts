import { describe, expect, it, vi } from "vitest";

import { createAdminActionRegistry } from "../actions/admin-registry.js";
import { InMemoryConfirmationStore } from "../actions/confirmation-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryKnowledgeStore } from "../knowledge/store.js";
import { listKnowledgeRoutingMetadata } from "../knowledge/routing-metadata.js";
import type { BotProfileConfig, LineEvent } from "../types.js";

const profile = {
  name: "helper",
  enabledFunctions: ["query_knowledge"],
  adminUserId: "Uroot",
  registration: { enabled: true }
} as BotProfileConfig;
const event = { type: "message", source: { type: "user", userId: "Uroot" } } as LineEvent;

describe("knowledge source admin actions", () => {
  it("adds and immediately synchronizes a shared page", async () => {
    const store = new InMemoryKnowledgeStore();
    const accessStore = new InMemoryAccessStore();
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store,
      notionKnowledge: {
        fetchRoot: vi.fn().mockResolvedValue([
          {
            externalId: "doc",
            title: "聚會 SOP",
            url: "https://www.notion.so/doc",
            properties: {},
            nodes: [{ externalId: "p", type: "paragraph", ordinal: 0, text: "關閉設備" }]
          }
        ])
      }
    });

    const result = await registry.execute({
      action: "knowledge_source_add",
      profile,
      event,
      arguments: {
        url: "https://www.notion.so/SOP-0123456789abcdef0123456789abcdef",
        displayName: "2026 青年出隊",
        aliases: ["出隊", "青年隊"],
        topics: ["集合"],
        sampleQueries: ["第一天去哪裡", "那幾點集合"]
      }
    });

    expect(result.replyText).toContain("已加入知識來源");
    await expect(store.search({ profileName: "helper", query: "關閉設備" })).resolves.toHaveLength(
      1
    );
    expect(accessStore.audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "knowledge.source.add" })])
    );
    await expect(store.listSources({ profileName: "helper" })).resolves.toEqual([
      expect.objectContaining({
        aliases: expect.arrayContaining(["出隊", "青年隊"]),
        topics: expect.arrayContaining(["聚會 SOP", "集合"]),
        sampleQueries: ["第一天去哪裡", "那幾點集合"]
      })
    ]);
  });

  it("lists routing metadata counts without echoing safe sample queries", async () => {
    const store = new InMemoryKnowledgeStore();
    await store.upsertSource({
      profileName: "helper",
      sourceKey: "retreat",
      displayName: "2026 青年出隊",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true,
      aliases: ["出隊"],
      topics: ["第一天"],
      sampleQueries: ["那幾點集合"]
    });
    const registry = createAdminActionRegistry({
      accessStore: new InMemoryAccessStore(),
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store
    });

    const result = await registry.execute({
      action: "knowledge_source_list",
      profile,
      event
    });

    expect(result.replyText).toContain("別名 1｜主題 1｜範例問題 1");
    expect(result.replyText).not.toContain("那幾點集合");
  });

  it("preserves the source key through destructive confirmation", async () => {
    const store = new InMemoryKnowledgeStore();
    await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop-12345678",
      displayName: "SOP",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test",
      enabled: true
    });
    const confirmationStore = new InMemoryConfirmationStore({ idFactory: () => "CONFIRM" });
    const registry = createAdminActionRegistry({
      accessStore: new InMemoryAccessStore(),
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      confirmationStore,
      knowledgeStore: store
    });

    const preview = await registry.execute({
      action: "knowledge_source_remove",
      profile,
      event,
      arguments: { sourceKey: "sop-12345678" }
    });
    expect(preview.replyText).toContain("/confirm CONFIRM");
    const committed = await registry.confirm({ code: "CONFIRM", profile, event });

    expect(committed.replyText).toContain("已永久移除");
    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([]);
  });

  it("keeps last-known-good routing metadata while recording a transient sync failure", async () => {
    const store = new InMemoryKnowledgeStore();
    await store.upsertSource({
      profileName: "helper",
      sourceKey: "retreat",
      displayName: "2026 青年出隊",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true,
      topics: ["第一天"]
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: "retreat",
      syncStatus: "ready",
      lastSyncedAt: "2026-07-12T00:00:00Z"
    });
    const accessStore = new InMemoryAccessStore();
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store,
      notionKnowledge: { fetchRoot: vi.fn().mockRejectedValue(new Error("temporary")) }
    });

    const result = await registry.execute({
      action: "knowledge_source_sync",
      profile,
      event,
      arguments: { sourceKey: "retreat" }
    });

    expect(result.replyText).toContain("同步失敗");
    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([
      expect.objectContaining({
        sourceKey: "retreat",
        syncStatus: "failed",
        syncErrorCode: "source_unavailable",
        lastSyncedAt: "2026-07-12T00:00:00Z"
      })
    ]);
    await expect(listKnowledgeRoutingMetadata(store, "helper", 20)).resolves.toEqual([
      expect.objectContaining({ sourceKey: "retreat" })
    ]);
    expect(accessStore.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "knowledge.source.sync",
          metadata: { outcome: "failed", errorCode: "source_unavailable" }
        })
      ])
    );
  });

  it("audits a failed add after persisting its diagnosable unsynced row", async () => {
    const store = new InMemoryKnowledgeStore();
    const accessStore = new InMemoryAccessStore();
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store,
      notionKnowledge: { fetchRoot: vi.fn().mockRejectedValue(new Error("private details")) }
    });

    const result = await registry.execute({
      action: "knowledge_source_add",
      profile,
      event,
      arguments: {
        url: "https://www.notion.so/Failed-0123456789abcdef0123456789abcdef",
        displayName: "失敗來源",
        aliases: ["暫存別名"]
      }
    });

    expect(result.replyText).toContain("無法讀取");
    const [failedSource] = await store.listSources({
      profileName: "helper",
      includeDisabled: true
    });
    expect(failedSource).toMatchObject({
      syncStatus: "failed",
      adminAliases: ["暫存別名"],
      aliases: []
    });
    expect(failedSource?.lastSyncedAt).toBeUndefined();
    expect(accessStore.audit).toEqual([
      expect.objectContaining({
        action: "knowledge.source.add",
        metadata: { outcome: "failed", errorCode: "source_unavailable" }
      })
    ]);
  });

  it("does not rewrite a successful promotion as failed when success audit persistence fails", async () => {
    const store = new InMemoryKnowledgeStore();
    const accessStore = new InMemoryAccessStore();
    vi.spyOn(accessStore, "recordAudit").mockRejectedValue(new Error("audit unavailable"));
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store,
      notionKnowledge: {
        fetchRoot: vi.fn().mockResolvedValue([
          {
            externalId: "doc",
            title: "聚會 SOP",
            url: "https://www.notion.so/doc",
            properties: {},
            nodes: [{ externalId: "p", type: "paragraph", ordinal: 0, text: "關閉設備" }]
          }
        ])
      }
    });

    await expect(
      registry.execute({
        action: "knowledge_source_add",
        profile,
        event,
        arguments: {
          url: "https://www.notion.so/SOP-0123456789abcdef0123456789abcdef",
          displayName: "聚會 SOP"
        }
      })
    ).rejects.toThrow("audit unavailable");

    await expect(store.listSources({ profileName: "helper" })).resolves.toEqual([
      expect.objectContaining({
        displayName: "聚會 SOP",
        enabled: true,
        syncStatus: "ready",
        syncErrorCode: undefined,
        lastSyncedAt: expect.any(String)
      })
    ]);
    await expect(store.search({ profileName: "helper", query: "關閉設備" })).resolves.toHaveLength(
      1
    );
  });

  it("keeps successful resync health truthful when the resync audit write fails", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc",
      title: "舊 SOP",
      url: "https://example.test/old",
      nodes: [],
      chunks: [{ headingPath: [], ordinal: 0, content: "舊版內容", contentHash: "old" }]
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: "sop",
      syncStatus: "ready",
      lastSyncedAt: "2026-07-12T00:00:00Z"
    });
    const accessStore = new InMemoryAccessStore();
    vi.spyOn(accessStore, "recordAudit").mockRejectedValue(new Error("audit unavailable"));
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store,
      notionKnowledge: {
        fetchRoot: vi.fn().mockResolvedValue([
          {
            externalId: "doc",
            title: "新 SOP",
            url: "https://example.test/new",
            properties: {},
            nodes: [{ externalId: "p", type: "paragraph", ordinal: 0, text: "新版內容" }]
          }
        ])
      }
    });

    await expect(
      registry.execute({
        action: "knowledge_source_sync",
        profile,
        event,
        arguments: { sourceKey: "sop" }
      })
    ).rejects.toThrow("audit unavailable");

    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([
      expect.objectContaining({
        syncStatus: "ready",
        syncErrorCode: undefined,
        lastSyncedAt: expect.not.stringContaining("2026-07-12")
      })
    ]);
    await expect(store.search({ profileName: "helper", query: "新版內容" })).resolves.toEqual([
      expect.objectContaining({ content: "新版內容" })
    ]);
  });

  it("does not let a stale admin sync failure overwrite a newer ready publication", async () => {
    const store = new InMemoryKnowledgeStore();
    const accessStore = new InMemoryAccessStore();
    let source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    source = await store.publishSourceSnapshot({
      sourceId: source.id,
      expectedStagingRevision: source.stagingRevision,
      syncedAt: "2026-07-12T00:00:00Z",
      syncStatus: "ready",
      routingDisplayName: "聚會 SOP",
      aliases: [],
      topics: [],
      sampleQueries: [],
      documents: [],
      embeddings: []
    });
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store,
      notionKnowledge: {
        fetchRoot: vi.fn(async () => {
          await store.publishSourceSnapshot({
            sourceId: source.id,
            expectedStagingRevision: source.stagingRevision,
            syncedAt: "2026-07-13T00:00:00Z",
            syncStatus: "ready",
            routingDisplayName: "聚會 SOP",
            aliases: [],
            topics: [],
            sampleQueries: [],
            documents: [],
            embeddings: []
          });
          return [];
        })
      }
    });

    await registry.execute({
      action: "knowledge_source_sync",
      profile,
      event,
      arguments: { sourceKey: "sop" }
    });

    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([
      expect.objectContaining({ syncStatus: "ready", syncErrorCode: undefined })
    ]);
    expect(accessStore.audit).toEqual([
      expect.objectContaining({
        action: "knowledge.source.sync",
        metadata: { outcome: "stale", errorCode: "staging_changed" }
      })
    ]);
  });

  it("does not let a stale admin add failure overwrite a newer ready publication", async () => {
    const store = new InMemoryKnowledgeStore();
    const accessStore = new InMemoryAccessStore();
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60,
      knowledgeStore: store,
      notionKnowledge: {
        fetchRoot: vi.fn(async () => {
          const [source] = await store.listSources({
            profileName: "helper",
            includeDisabled: true
          });
          await store.publishSourceSnapshot({
            sourceId: source!.id,
            expectedStagingRevision: source!.stagingRevision,
            syncedAt: "2026-07-13T00:00:00Z",
            syncStatus: "ready",
            routingDisplayName: source!.stagedDisplayName,
            aliases: [],
            topics: [],
            sampleQueries: [],
            documents: [],
            embeddings: []
          });
          return [];
        })
      }
    });

    await registry.execute({
      action: "knowledge_source_add",
      profile,
      event,
      arguments: {
        url: "https://www.notion.so/SOP-0123456789abcdef0123456789abcdef",
        displayName: "聚會 SOP"
      }
    });

    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([
      expect.objectContaining({ syncStatus: "ready", syncErrorCode: undefined })
    ]);
    expect(accessStore.audit).toEqual([
      expect.objectContaining({
        action: "knowledge.source.add",
        metadata: { outcome: "stale", errorCode: "staging_changed" }
      })
    ]);
  });
});
