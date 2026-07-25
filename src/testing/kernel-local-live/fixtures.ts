import { createHash } from "node:crypto";

import type { AccessStore } from "../../access/types.js";
import type { CatalogStore } from "../../catalog/store.js";
import type { EmbeddingClient } from "../../clients/embedding.js";
import type { KnowledgeStore } from "../../knowledge/store.js";
import type { ScheduleStore } from "../../schedules/store.js";

const PROFILE_NAME = "acceptance";
const CREATED_BY = "U_KERNEL_ADMIN";
const KNOWLEDGE_CHUNKS = [
  {
    headingPath: ["Synthetic Section A"],
    ordinal: 0,
    content: "Synthetic procedure begins with alpha and finishes with beta."
  },
  {
    headingPath: ["Synthetic Section B"],
    ordinal: 1,
    content: "Synthetic follow-up assigns the final verification to role gamma."
  }
] as const;

export async function seedKernelLocalLiveFixtures(options: {
  accessStore: AccessStore;
  catalogStore: CatalogStore;
  scheduleStore: ScheduleStore;
  knowledgeStore: KnowledgeStore;
  embedding: EmbeddingClient;
  seedKnowledge?: boolean;
  now?: () => Date;
}): Promise<void> {
  const now = options.now?.() ?? new Date();
  await Promise.all([
    options.accessStore.addPrincipal({
      profileName: PROFILE_NAME,
      type: "user",
      principalId: "U_KERNEL_USER_A",
      displayName: "Synthetic User A",
      createdBy: CREATED_BY
    }),
    options.accessStore.addPrincipal({
      profileName: PROFILE_NAME,
      type: "user",
      principalId: "U_KERNEL_USER_B",
      displayName: "Synthetic User B",
      createdBy: CREATED_BY
    }),
    options.accessStore.addPrincipal({
      profileName: PROFILE_NAME,
      type: "group",
      principalId: "G_KERNEL_GROUP",
      displayName: "Synthetic Group",
      createdBy: CREATED_BY
    })
  ]);
  await options.accessStore.addUserFunctionGrant({
    profileName: PROFILE_NAME,
    userId: "U_KERNEL_USER_A",
    functionName: "save_resource",
    createdBy: CREATED_BY
  });
  await options.catalogStore.upsertSource({
    profileName: PROFILE_NAME,
    sourceKey: "xiaoha_database",
    adapterType: "manual",
    domain: "general",
    defaultItemKind: "church_document",
    rootLocation: { kind: "synthetic" },
    enabled: true,
    syncPolicy: { mode: "manual", allowedExtensions: [".txt"] },
    capabilities: {
      read: ["general_resource"],
      write: ["general_resource"]
    }
  });
  await options.scheduleStore.publishSnapshot({
    profileName: PROFILE_NAME,
    sourceKey: "synthetic-schedule",
    origin: "line",
    revision: "kernel-local-live-v1",
    publishedAt: now.toISOString(),
    items: [
      {
        profileName: PROFILE_NAME,
        sourceKey: "synthetic-schedule",
        origin: "line",
        serviceDate: "2026-07-27",
        meeting: "Synthetic Morning",
        role: "投影",
        assignee: "Synthetic A"
      },
      {
        profileName: PROFILE_NAME,
        sourceKey: "synthetic-schedule",
        origin: "line",
        serviceDate: "2026-07-27",
        meeting: "Synthetic Morning",
        role: "音控",
        assignee: "Synthetic B"
      },
      {
        profileName: PROFILE_NAME,
        sourceKey: "synthetic-schedule",
        origin: "line",
        serviceDate: "2026-08-03",
        meeting: "Synthetic Evening",
        role: "投影",
        assignee: "Synthetic C"
      }
    ]
  });

  if (options.seedKnowledge === false) return;
  const source = await options.knowledgeStore.upsertSource({
    profileName: PROFILE_NAME,
    sourceKey: "synthetic-handbook",
    displayName: "Synthetic Handbook",
    adapterType: "notion",
    externalRootId: "synthetic-root",
    rootUrl: "https://synthetic.invalid/root",
    enabled: true,
    aliases: ["synthetic handbook"],
    topics: ["synthetic procedure"],
    sampleQueries: ["synthetic alpha procedure"]
  });
  const vectors = await options.embedding.embed(KNOWLEDGE_CHUNKS.map(({ content }) => content));
  const documents = [
    {
      externalId: "synthetic-document",
      title: "Synthetic Procedure",
      url: "https://synthetic.invalid/document",
      nodes: [],
      chunks: KNOWLEDGE_CHUNKS.map((chunk) => ({
        ...chunk,
        headingPath: [...chunk.headingPath],
        contentHash: contentHash(chunk.content)
      }))
    }
  ];
  await options.knowledgeStore.publishSourceSnapshot({
    sourceId: source.id,
    expectedStagingRevision: source.stagingRevision,
    syncedAt: now.toISOString(),
    syncStatus: "ready",
    routingDisplayName: "Synthetic Handbook",
    aliases: ["synthetic handbook"],
    topics: ["synthetic procedure"],
    sampleQueries: ["synthetic alpha procedure"],
    documents,
    embeddings: KNOWLEDGE_CHUNKS.map((chunk, index) => ({
      documentExternalId: "synthetic-document",
      contentHash: contentHash(chunk.content),
      provider: options.embedding.provider,
      model: options.embedding.model,
      dimensions: options.embedding.dimensions,
      embedding: vectors[index]!
    }))
  });
}

function contentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
