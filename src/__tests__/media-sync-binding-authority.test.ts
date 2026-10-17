import { describe, expect, it, vi } from "vitest";
import { MediaSyncManagementService } from "../media-sync/service.js";
import type { PostgresMediaSyncStore } from "../media-sync/store.js";
import type { AssetApiClient } from "../clients/asset-api.js";
const input = {
  profileName: "helper",
  code: "synthetic-code",
  groupId: "group",
  groupDisplayName: "Synthetic group",
  requestId: "bind-request"
};
function fixture() {
  const inspectBindingCode = vi.fn().mockResolvedValue({
    id: "code-id",
    collectionId: "collection",
    createdByHhcUserId: "creator"
  });
  const bindWithCode = vi.fn().mockResolvedValue({ status: "bound", binding: { id: "binding" } });
  const verifyPermission = vi.fn().mockResolvedValue(true);
  const getManagedCollection = vi
    .fn()
    .mockResolvedValue({ collection: { id: "collection", name: "Synthetic folder" }, acls: [] });
  const service = new MediaSyncManagementService(
    { getManagedCollection } as unknown as AssetApiClient,
    { inspectBindingCode, bindWithCode } as unknown as PostgresMediaSyncStore,
    { verifyPermission }
  );
  return { service, inspectBindingCode, bindWithCode, verifyPermission, getManagedCollection };
}
describe("media binding current creator authority", () => {
  it("checks the issuer and exact collection before consuming the inspected code", async () => {
    const f = fixture();
    expect(await f.service.bindWithCode(input)).toMatchObject({
      status: "bound",
      collectionName: "Synthetic folder"
    });
    expect(f.verifyPermission).toHaveBeenCalledWith({
      userId: "creator",
      requestId: "bind-request"
    });
    expect(f.getManagedCollection).toHaveBeenCalledWith("collection", {
      actorUserId: "creator",
      requestId: "bind-request"
    });
    expect(f.bindWithCode).toHaveBeenCalledWith({ ...input, expectedCodeId: "code-id" });
    expect(f.getManagedCollection.mock.invocationCallOrder[0]).toBeLessThan(
      f.bindWithCode.mock.invocationCallOrder[0]!
    );
  });
  it.each(["missing", "revoked", "deleted", "unavailable"])(
    "does not consume when authority is %s",
    async (scenario) => {
      const f = fixture();
      if (scenario === "missing") f.inspectBindingCode.mockResolvedValue(undefined);
      if (scenario === "revoked") f.verifyPermission.mockResolvedValue(false);
      if (scenario === "deleted")
        f.getManagedCollection.mockResolvedValue({
          collection: { deletedAt: "2026-10-16T00:00:00Z" }
        });
      if (scenario === "unavailable")
        f.getManagedCollection.mockRejectedValue(new Error("offline"));
      if (scenario === "unavailable")
        await expect(f.service.bindWithCode(input)).rejects.toThrow("offline");
      else expect(await f.service.bindWithCode(input)).toEqual({ status: "invalid_code" });
      expect(f.bindWithCode).not.toHaveBeenCalled();
    }
  );
});

describe("conversation media status authority", () => {
  function statusFixture() {
    const binding = { id: "binding", collectionId: "collection", version: 1 };
    const findActiveBinding = vi.fn().mockResolvedValue(binding);
    const isBindingAdmitted = vi.fn().mockResolvedValue(true);
    const listCollectionStatus = vi.fn().mockResolvedValue({
      totalReceived: 3,
      counts: { published: 1, processing: 2 },
      items: [{ workId: "not-model-visible" }]
    });
    const getManagedCollection = vi.fn().mockResolvedValue({ collection: { id: "collection" } });
    const service = new MediaSyncManagementService(
      { getManagedCollection } as unknown as AssetApiClient,
      {
        findActiveBinding,
        isBindingAdmitted,
        listCollectionStatus
      } as unknown as PostgresMediaSyncStore,
      { verifyPermission: async () => true }
    );
    return {
      service,
      findActiveBinding,
      isBindingAdmitted,
      listCollectionStatus,
      getManagedCollection,
      binding
    };
  }
  it("rechecks current collection ACL and returns bounded group counts without work identifiers", async () => {
    const f = statusFixture();
    const result = await f.service.readConversationStatus(
      "group",
      "request",
      "actor",
      new Date("2026-10-17T01:00:00Z")
    );
    expect(result).toEqual({
      state: "active",
      from: "2026-10-17T00:45:00.000Z",
      until: "2026-10-17T01:00:00.000Z",
      totalReceived: 3,
      counts: { published: 1, processing: 2 }
    });
    expect(f.getManagedCollection).toHaveBeenCalledWith("collection", {
      requestId: "request",
      actorUserId: "actor"
    });
    expect(f.listCollectionStatus).toHaveBeenCalledWith("collection", {
      from: "2026-10-17T00:45:00.000Z",
      until: "2026-10-17T01:00:00.000Z",
      limit: 1
    });
    expect(JSON.stringify(result)).not.toContain("not-model-visible");
  });
  it("does not read counts when current ACL denies the requester", async () => {
    const f = statusFixture();
    f.getManagedCollection.mockRejectedValue(new Error("denied"));
    await expect(f.service.readConversationStatus("group", "request", "actor")).rejects.toThrow(
      "denied"
    );
    expect(f.listCollectionStatus).not.toHaveBeenCalled();
  });
  it("does not expose an old collection after a concurrent binding change", async () => {
    const f = statusFixture();
    f.findActiveBinding
      .mockResolvedValueOnce(f.binding)
      .mockResolvedValueOnce({ ...f.binding, id: "replacement" });
    expect(await f.service.readConversationStatus("group", "request", "actor")).toEqual({
      state: "unavailable"
    });
  });
});
