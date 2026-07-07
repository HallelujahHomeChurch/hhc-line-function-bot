import { describe, expect, it } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";

describe("access store", () => {
  it("tracks profile-scoped active principals", async () => {
    const store = new InMemoryAccessStore();

    await store.addPrincipal({
      profileName: "helper",
      type: "user",
      principalId: "U1",
      createdBy: "Uadmin"
    });

    await expect(store.hasActivePrincipal("helper", "user", "U1")).resolves.toBe(true);
    await expect(store.hasActivePrincipal("main", "user", "U1")).resolves.toBe(false);
  });

  it("tracks profile-scoped group function grants", async () => {
    const store = new InMemoryAccessStore();

    await store.addGroupFunctionGrant({
      profileName: "helper",
      groupId: "C1",
      functionName: "find_ppt_slides",
      createdBy: "Uadmin"
    });

    await expect(store.listGroupFunctionGrants("helper", "C1")).resolves.toEqual([
      "find_ppt_slides"
    ]);
    await expect(store.listGroupFunctionGrants("main", "C1")).resolves.toEqual([]);
    await expect(store.listGroupFunctionGrants("helper", "C2")).resolves.toEqual([]);

    await expect(
      store.disableGroupFunctionGrant({
        profileName: "helper",
        groupId: "C1",
        functionName: "find_ppt_slides",
        disabledBy: "Uadmin"
      })
    ).resolves.toBe(true);
    await expect(store.listGroupFunctionGrants("helper", "C1")).resolves.toEqual([]);
  });
});
