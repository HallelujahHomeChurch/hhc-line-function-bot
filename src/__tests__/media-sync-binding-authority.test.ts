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
