import { describe, expect, it } from "vitest";

import { InMemoryConfirmationStore } from "../actions/confirmation-store.js";

describe("confirmation store", () => {
  it("consumes a confirmation request once for the same admin and profile", async () => {
    const store = new InMemoryConfirmationStore({
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    const request = await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toMatchObject({
      id: request.id,
      action: "invite_code_create"
    });
    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toBeNull();
  });

  it("does not consume confirmation requests from another admin or profile", async () => {
    const store = new InMemoryConfirmationStore({
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    await expect(store.consume("CONFIRM1", "Uother", "helper")).resolves.toBeNull();
    await expect(store.consume("CONFIRM1", "Uadmin", "other-profile")).resolves.toBeNull();
    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toMatchObject({
      action: "invite_code_create"
    });
  });

  it("expires confirmation requests", async () => {
    let now = new Date("2026-07-07T00:00:00.000Z");
    const store = new InMemoryConfirmationStore({
      idFactory: () => "CONFIRM1",
      now: () => now
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    now = new Date("2026-07-07T00:06:00.000Z");

    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toBeNull();
  });
});
