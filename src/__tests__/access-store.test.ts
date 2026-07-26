import { describe, expect, it } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { PostgresAccessStore } from "../access/postgres-access-store.js";

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

  it("lists disabled principals only when requested and keeps the newest success", async () => {
    const store = new InMemoryAccessStore();
    await store.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "C1",
      displayName: "影音同工群",
      createdBy: "Uadmin"
    });

    await store.recordPrincipalSuccess({
      profileName: "helper",
      type: "group",
      principalId: "C1",
      functionName: "find_ppt_slides",
      occurredAt: "2026-07-26T10:00:00.000Z"
    });
    await store.recordPrincipalSuccess({
      profileName: "helper",
      type: "group",
      principalId: "C1",
      functionName: "query_schedule",
      occurredAt: "2026-07-26T09:00:00.000Z"
    });
    await store.disablePrincipal({
      profileName: "helper",
      type: "group",
      principalId: "C1",
      disabledBy: "Uadmin"
    });
    await store.recordPrincipalSuccess({
      profileName: "helper",
      type: "group",
      principalId: "C1",
      functionName: "query_schedule",
      occurredAt: "2026-07-26T11:00:00.000Z"
    });

    await expect(store.listPrincipals("helper")).resolves.toEqual([]);
    await expect(store.listPrincipals("helper", { includeDisabled: true })).resolves.toMatchObject([
      {
        type: "group",
        principalId: "C1",
        disabledAt: expect.any(String),
        lastSuccessFunctionName: "find_ppt_slides",
        lastSuccessAt: "2026-07-26T10:00:00.000Z"
      }
    ]);
  });

  it("maps PostgreSQL success metadata and emits a monotonic active-principal update", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const store = new PostgresAccessStore({
      async query(sql, values) {
        queries.push({ sql, values });
        if (/select \*/u.test(sql)) {
          return {
            rows: [
              {
                id: "principal-1",
                profile_name: "helper",
                principal_type: "group",
                principal_id: "C1",
                display_name: "影音同工群",
                created_at: new Date("2026-07-01T00:00:00.000Z"),
                created_by: "Uadmin",
                disabled_at: new Date("2026-07-25T00:00:00.000Z"),
                disabled_by: "Uadmin",
                last_success_function_name: "find_ppt_slides",
                last_success_at: new Date("2026-07-26T10:00:00.000Z")
              }
            ]
          };
        }
        return { rows: [] };
      }
    });

    await expect(store.listPrincipals("helper", { includeDisabled: true })).resolves.toMatchObject([
      {
        principalId: "C1",
        disabledAt: "2026-07-25T00:00:00.000Z",
        lastSuccessFunctionName: "find_ppt_slides",
        lastSuccessAt: "2026-07-26T10:00:00.000Z"
      }
    ]);
    await store.recordPrincipalSuccess({
      profileName: "helper",
      type: "group",
      principalId: "C1",
      functionName: "query_schedule",
      occurredAt: "2026-07-26T11:00:00.000Z"
    });

    expect(queries[0]?.sql).not.toContain("disabled_at is null");
    expect(queries[1]).toMatchObject({
      values: ["helper", "group", "C1", "query_schedule", "2026-07-26T11:00:00.000Z"]
    });
    expect(queries[1]?.sql).toContain("disabled_at is null");
    expect(queries[1]?.sql).toContain("last_success_at <= $5");
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

  it("tracks profile-scoped user function grants", async () => {
    const store = new InMemoryAccessStore();

    await store.addUserFunctionGrant({
      profileName: "helper",
      userId: "U1",
      functionName: "save_schedule",
      createdBy: "Uadmin"
    });

    await expect(store.listUserFunctionGrants("helper", "U1")).resolves.toEqual(["save_schedule"]);
    await expect(store.listUserFunctionGrants("main", "U1")).resolves.toEqual([]);
    await expect(store.listUserFunctionGrants("helper", "U2")).resolves.toEqual([]);
    await expect(store.listAllUserFunctionGrants("helper")).resolves.toMatchObject([
      { profileName: "helper", userId: "U1", functionName: "save_schedule" }
    ]);

    await expect(
      store.disableUserFunctionGrant({
        profileName: "helper",
        userId: "U1",
        functionName: "save_schedule",
        disabledBy: "Uadmin"
      })
    ).resolves.toBe(true);
    await expect(store.listUserFunctionGrants("helper", "U1")).resolves.toEqual([]);
  });

  it("resolves profile-scoped role capabilities for user and group principals", async () => {
    const store = new InMemoryAccessStore();
    const role = await store.upsertRole({
      profileName: "helper",
      roleKey: "media_reader",
      displayName: "Media reader"
    });
    await store.bindRoleCapability(role.id, "function:find_resource:execute");
    await store.bindRoleToPrincipal({
      profileName: "helper",
      principalType: "user",
      principalId: "U1",
      roleId: role.id
    });
    await store.bindRoleToPrincipal({
      profileName: "helper",
      principalType: "group",
      principalId: "C1",
      roleId: role.id
    });

    await expect(store.listPrincipalCapabilities("helper", "user", "U1")).resolves.toEqual([
      "function:find_resource:execute"
    ]);
    await expect(store.listPrincipalCapabilities("helper", "group", "C1")).resolves.toEqual([
      "function:find_resource:execute"
    ]);
    await expect(store.listPrincipalCapabilities("main", "user", "U1")).resolves.toEqual([]);
  });
});
