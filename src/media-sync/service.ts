import { createHash } from "node:crypto";

import type {
  AssetApiClient,
  CollectionSubjectType,
  ManagedCollection
} from "../clients/asset-api.js";
import type { PostgresMediaSyncStore } from "./store.js";

export class MediaSyncManagementError extends Error {
  constructor(
    readonly code: "collection_deleted" | "collection_bound" | "binding_code_already_issued"
  ) {
    super(code);
  }
}

export class MediaSyncManagementService {
  constructor(
    private readonly assets: AssetApiClient,
    private readonly store: PostgresMediaSyncStore
  ) {}

  async listCollections(
    input: { cursor?: string; limit?: number },
    requestId: string
  ): Promise<{
    collections: Array<
      ManagedCollection & {
        binding: { groupId: string; groupDisplayName: string; boundAt: string } | null;
        pendingBinding: { expiresAt: string } | null;
      }
    >;
    cursor?: string;
    hasMore: boolean;
  }> {
    const page = await this.assets.listManagedCollections(input, { requestId });
    const collections = await Promise.all(
      page.collections.map(async (managed) => {
        const binding = await this.store.findActiveBindingByCollection(managed.collection.id);
        const pendingBinding = binding
          ? undefined
          : await this.store.findPendingBindingCodeByCollection({
              profileName: "helper",
              collectionId: managed.collection.id
            });
        return {
          ...managed,
          binding: binding
            ? {
                groupId: binding.groupId,
                groupDisplayName: binding.groupDisplayName,
                boundAt: binding.boundAt
              }
            : null,
          pendingBinding: pendingBinding ?? null
        };
      })
    );
    return {
      collections,
      ...(page.cursor ? { cursor: page.cursor } : {}),
      hasMore: page.hasMore
    };
  }

  createCollection(name: string, idempotencyKey: string, requestId: string) {
    return this.assets.createCollection(name, idempotencyKey, { requestId });
  }

  listCollectionItems(
    collectionId: string,
    input: { query?: string; cursor?: string; limit?: number },
    requestId: string
  ) {
    return this.assets.listManagedCollectionItems(collectionId, input, { requestId });
  }

  updateCollectionRetention(
    collectionId: string,
    retentionDays: number,
    idempotencyKey: string,
    requestId: string
  ) {
    return this.assets.updateCollectionRetention(collectionId, retentionDays, idempotencyKey, {
      requestId
    });
  }

  renameCollectionItem(
    collectionId: string,
    itemId: string,
    displayName: string,
    idempotencyKey: string,
    requestId: string
  ) {
    return this.assets.renameManagedCollectionItem(
      collectionId,
      itemId,
      displayName,
      idempotencyKey,
      { requestId }
    );
  }

  setCollectionItemsRetention(
    collectionId: string,
    input: { itemIds: string[]; retentionExempt: boolean },
    idempotencyKey: string,
    requestId: string
  ) {
    return this.assets.setManagedCollectionItemsRetention(collectionId, input, idempotencyKey, {
      requestId
    });
  }

  deleteCollectionItems(
    collectionId: string,
    itemIds: string[],
    idempotencyKey: string,
    requestId: string
  ) {
    return this.assets.deleteManagedCollectionItems(collectionId, itemIds, idempotencyKey, {
      requestId
    });
  }

  issueCollectionItemTickets(collectionId: string, itemIds: string[], requestId: string) {
    return this.assets.issueManagedContentTickets(collectionId, itemIds, { requestId });
  }

  renameCollection(collectionId: string, name: string, idempotencyKey: string, requestId: string) {
    return this.assets.renameCollection(collectionId, name, idempotencyKey, { requestId });
  }

  async deleteCollection(collectionId: string, _idempotencyKey: string, requestId: string) {
    await this.store.beginCollectionDeletion({ profileName: "helper", collectionId });
    const result = await this.assets.deleteCollection(
      collectionId,
      `media-sync-delete-collection:${createHash("sha256").update(collectionId).digest("hex")}`,
      { requestId }
    );
    await this.store.completeCollectionDeletion({ profileName: "helper", collectionId });
    return result;
  }

  addCollectionAcl(
    collectionId: string,
    input: { subjectType: CollectionSubjectType; subjectId: string },
    idempotencyKey: string,
    requestId: string
  ) {
    return this.assets.addCollectionAcl(collectionId, input, idempotencyKey, { requestId });
  }

  revokeCollectionAcl(
    collectionId: string,
    aclId: string,
    idempotencyKey: string,
    requestId: string
  ) {
    return this.assets.revokeCollectionAcl(collectionId, aclId, idempotencyKey, { requestId });
  }

  async createBindingCode(
    collectionId: string,
    userId: string,
    idempotencyKey: string,
    requestId: string
  ) {
    const managed = await this.assets.getManagedCollection(collectionId, { requestId });
    if (managed.collection.deletedAt) {
      throw new MediaSyncManagementError("collection_deleted");
    }
    if (await this.store.findActiveBindingByCollection(collectionId)) {
      throw new MediaSyncManagementError("collection_bound");
    }
    const issued = await this.store.createBindingCode({
      profileName: "helper",
      collectionId,
      createdByHhcUserId: userId,
      idempotencyKey
    });
    if (issued.status === "already_issued") {
      throw new MediaSyncManagementError("binding_code_already_issued");
    }
    if (issued.status === "collection_bound") {
      throw new MediaSyncManagementError("collection_bound");
    }
    return { command: `/media-sync ${issued.code}`, expiresAt: issued.expiresAt };
  }
}
