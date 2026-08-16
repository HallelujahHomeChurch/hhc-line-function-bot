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
      }
    >;
    cursor?: string;
    hasMore: boolean;
  }> {
    const page = await this.assets.listManagedCollections(input, { requestId });
    const collections = await Promise.all(
      page.collections.map(async (managed) => {
        const binding = await this.store.findActiveBindingByCollection(managed.collection.id);
        return {
          ...managed,
          binding: binding
            ? {
                groupId: binding.groupId,
                groupDisplayName: binding.groupDisplayName,
                boundAt: binding.boundAt
              }
            : null
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

  renameCollection(collectionId: string, name: string, idempotencyKey: string, requestId: string) {
    return this.assets.renameCollection(collectionId, name, idempotencyKey, { requestId });
  }

  async deleteCollection(collectionId: string, idempotencyKey: string, requestId: string) {
    const result = await this.assets.deleteCollection(collectionId, idempotencyKey, { requestId });
    await this.store.disableBindingByCollection(collectionId);
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
    return { command: `/media-sync ${issued.code}`, expiresAt: issued.expiresAt };
  }

  async unbind(collectionId: string): Promise<{ unbound: boolean }> {
    return { unbound: await this.store.disableBindingByCollection(collectionId) };
  }
}
