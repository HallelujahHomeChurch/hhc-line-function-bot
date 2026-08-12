import { describe, expect, it } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import {
  isDefaultUserFunctionAvailable,
  resolveEffectiveAccessContext
} from "../application/access/effective-access.js";
import type { BotProfileConfig, LineEvent } from "../types.js";

function profile(overrides: Partial<BotProfileConfig> = {}): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["query_schedule"],
    permissionRequiredFunctions: [],
    adminUserId: "Uadmin",
    adminDirectOnly: true,
    directAccessPolicy: "managed",
    groupAccessPolicy: "managed",
    ...overrides
  } as BotProfileConfig;
}

function directEvent(userId?: string): LineEvent {
  return { type: "message", source: { type: "user", userId } };
}

function groupEvent(groupId: string, userId?: string): LineEvent {
  return { type: "message", source: { type: "group", groupId, userId } };
}

async function registeredStore(event: LineEvent): Promise<InMemoryAccessStore> {
  const store = new InMemoryAccessStore();
  if (event.source.type === "user" && event.source.userId) {
    await store.addPrincipal({
      profileName: "helper",
      type: "user",
      principalId: event.source.userId,
      createdBy: "test"
    });
  }
  if (event.source.type === "group" && event.source.groupId) {
    await store.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: event.source.groupId,
      createdBy: "test"
    });
  }
  return store;
}

describe("effective access context", () => {
  it.each([
    ["unregistered direct user", directEvent("U1"), false, []],
    ["registered direct user", directEvent("U1"), true, ["query_schedule"]],
    ["registered group requester", groupEvent("C1", "U1"), true, ["query_schedule"]],
    ["blocked group", groupEvent("C1", "U1"), false, []]
  ])("%s", async (name, event, authorized, functions) => {
    const accessStore =
      name === "unregistered direct user"
        ? new InMemoryAccessStore()
        : await registeredStore(event);
    const context = await resolveEffectiveAccessContext({
      profile: profile({
        groupAccessPolicy: name === "blocked group" ? "blocked" : "managed"
      }),
      event,
      accessStore
    });

    expect(context.authorized).toBe(authorized);
    expect(context.profile.enabledFunctions).toEqual(functions);
  });

  it("keeps legacy grants and role capabilities out of effective functions", async () => {
    const accessStore = await registeredStore(groupEvent("C1", "U1"));
    await accessStore.addGroupFunctionGrant({
      profileName: "helper",
      groupId: "C1",
      functionName: "find_sheet_music",
      createdBy: "test"
    });
    await accessStore.addUserFunctionGrant({
      profileName: "helper",
      userId: "U1",
      functionName: "save_memory",
      createdBy: "test"
    });
    const groupRole = await accessStore.upsertRole({
      profileName: "helper",
      roleKey: "resource-reader",
      displayName: "Resource reader"
    });
    await accessStore.bindRoleCapability(groupRole.id, "function:find_resource:execute");
    await accessStore.bindRoleToPrincipal({
      profileName: "helper",
      principalType: "group",
      principalId: "C1",
      roleId: groupRole.id
    });
    const userRole = await accessStore.upsertRole({
      profileName: "helper",
      roleKey: "schedule-writer",
      displayName: "Schedule writer"
    });
    await accessStore.bindRoleCapability(userRole.id, "function:save_schedule:execute");
    await accessStore.bindRoleToPrincipal({
      profileName: "helper",
      principalType: "user",
      principalId: "U1",
      roleId: userRole.id
    });

    const context = await resolveEffectiveAccessContext({
      profile: profile({
        enabledFunctions: ["query_schedule", "save_resource", "find_ppt_slides"]
      }),
      event: groupEvent("C1", "U1"),
      accessStore
    });

    expect(context.authorized).toBe(true);
    expect(context.profile.enabledFunctions).toEqual(["query_schedule", "find_ppt_slides"]);
  });

  it("does not make save_resource effective from a grant when the profile omits it", async () => {
    const accessStore = await registeredStore(directEvent("U1"));
    await accessStore.addUserFunctionGrant({
      profileName: "helper",
      userId: "U1",
      functionName: "save_resource",
      createdBy: "test"
    });

    const context = await resolveEffectiveAccessContext({
      profile: profile({ enabledFunctions: ["query_schedule"] }),
      event: directEvent("U1"),
      accessStore
    });

    expect(context.profile.enabledFunctions).toEqual(["query_schedule"]);
  });

  it("keeps configured write defaults for an admin", async () => {
    const context = await resolveEffectiveAccessContext({
      profile: profile({ enabledFunctions: ["query_schedule", "save_memory"] }),
      event: directEvent("Uadmin"),
      accessStore: new InMemoryAccessStore(),
      requesterIsAdmin: true
    });

    expect(context).toMatchObject({
      authorized: true,
      requesterIsAdmin: true,
      sourceType: "user"
    });
    expect(context.profile.enabledFunctions).toEqual(["query_schedule", "save_memory"]);
  });

  it("authorizes public direct access without a registered requester", async () => {
    const context = await resolveEffectiveAccessContext({
      profile: profile({ directAccessPolicy: "public" }),
      event: directEvent("Uguest"),
      accessStore: new InMemoryAccessStore()
    });

    expect(context).toMatchObject({
      authorized: true,
      requesterIsAdmin: false,
      sourceType: "user"
    });
    expect(context.profile.enabledFunctions).toEqual(["query_schedule"]);
  });

  it("does not let an admin bypass a blocked source policy", async () => {
    const context = await resolveEffectiveAccessContext({
      profile: profile({ directAccessPolicy: "blocked" }),
      event: directEvent("Uadmin"),
      accessStore: new InMemoryAccessStore(),
      requesterIsAdmin: true
    });

    expect(context).toMatchObject({
      authorized: false,
      requesterIsAdmin: true,
      sourceType: "user"
    });
    expect(context.profile.enabledFunctions).toEqual([]);
  });

  it("keeps unsupported rooms unauthorized even when rooms are allowed", async () => {
    const context = await resolveEffectiveAccessContext({
      profile: profile({ allowRooms: true }),
      event: { type: "message", source: { type: "room", roomId: "R1", userId: "U1" } },
      accessStore: new InMemoryAccessStore()
    });

    expect(context).toMatchObject({
      authorized: false,
      requesterIsAdmin: false,
      sourceType: "room"
    });
    expect(context.profile.enabledFunctions).toEqual([]);
  });

  it("does not authorize managed direct access without a requester ID", async () => {
    const context = await resolveEffectiveAccessContext({
      profile: profile(),
      event: directEvent(),
      accessStore: new InMemoryAccessStore()
    });

    expect(context).toMatchObject({
      authorized: false,
      requesterIsAdmin: false,
      sourceType: "user"
    });
    expect(context.profile.enabledFunctions).toEqual([]);
  });

  it("exposes only read functions as ordinary profile defaults", () => {
    expect(isDefaultUserFunctionAvailable("query_schedule")).toBe(true);
    expect(isDefaultUserFunctionAvailable("update_own_profile")).toBe(false);
    expect(isDefaultUserFunctionAvailable("save_memory")).toBe(false);
  });

  it("exposes main own-profile self service to a public direct user", async () => {
    const context = await resolveEffectiveAccessContext({
      profile: profile({
        name: "main",
        directAccessPolicy: "public",
        groupAccessPolicy: "blocked",
        enabledFunctions: ["download_weekly_paper", "update_own_profile"],
        permissionRequiredFunctions: []
      }),
      event: directEvent("Uguest"),
      accessStore: new InMemoryAccessStore()
    });

    expect(context.profile.enabledFunctions).toEqual([
      "download_weekly_paper",
      "update_own_profile"
    ]);

    const helperContext = await resolveEffectiveAccessContext({
      profile: profile({
        directAccessPolicy: "public",
        enabledFunctions: ["query_schedule", "update_own_profile"]
      }),
      event: directEvent("Uguest"),
      accessStore: new InMemoryAccessStore()
    });
    expect(helperContext.profile.enabledFunctions).toEqual(["query_schedule"]);
  });
});
