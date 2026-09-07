import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAgentMemoryStore,
  type SaveAgentScheduleMemoryInput
} from "../agent/memory-store.js";
import { runAgentMemoryMigrations } from "../agent/migrations.js";
import { createKernelPostgresEnvironment } from "../evals/kernel/integration/environment.js";
import { PostgresAgentMemoryStore } from "../agent/postgres-memory-store.js";

const input = (month: string, assignee = "Original"): SaveAgentScheduleMemoryInput => ({
  profileName: "helper",
  source: { type: "user", userId: "test" },
  scheduleType: "custom_service_schedule",
  periodKey: month,
  title: "Schedule",
  originalText: assignee,
  entries: [{ serviceDate: `${month}-01`, meetingName: "Service", assignee }]
});

describe("atomic schedule batches", () => {
  it("replaces only batch months and preserves originals on invalid later input", async () => {
    const store = new InMemoryAgentMemoryStore();
    await store.saveScheduleMemories([input("2026-07"), input("2026-08"), input("2026-09")]);
    await expect(
      store.saveScheduleMemories([
        input("2026-07", "Changed"),
        {
          ...input("2026-08"),
          entries: [{ serviceDate: "2026-02-30", meetingName: "Service", assignee: "Invalid" }]
        }
      ])
    ).rejects.toThrow();
    expect(
      (await store.listScheduleMemories({ profileName: "helper" })).every(
        (m) => m.entries[0]?.assignee === "Original"
      )
    ).toBe(true);
    await store.saveScheduleMemories([input("2026-07", "Changed"), input("2026-08", "Changed")]);
    const records = await store.listScheduleMemories({ profileName: "helper" });
    expect(records).toHaveLength(3);
    expect(records.find((m) => m.periodKey === "2026-09")?.entries[0]?.assignee).toBe("Original");
    expect(records.find((m) => m.periodKey === "2026-07")?.entries[0]?.assignee).toBe("Changed");
  });

  it("rejects duplicate canonical months before either backend changes state", async () => {
    const query = vi.fn();
    for (const store of [new InMemoryAgentMemoryStore(), new PostgresAgentMemoryStore({ query })]) {
      await expect(
        store.saveScheduleMemories([input("2026-07"), input("2026-07")])
      ).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.KERNEL_POSTGRES_URL)("Postgres atomic schedule batches", () => {
  it("rolls back an entry insert failure and isolates concurrent replacements", async () => {
    const environment = await createKernelPostgresEnvironment();
    try {
      const [left, right] = environment.pools;
      await runAgentMemoryMigrations(left);
      const store = new PostgresAgentMemoryStore(left);
      const initial = await store.saveScheduleMemories([
        input("2026-07"),
        input("2026-08"),
        input("2026-09")
      ]);
      expect(initial.map((m) => m.entries[0]?.serviceDate)).toEqual([
        "2026-07-01",
        "2026-08-01",
        "2026-09-01"
      ]);
      expect(
        initial.every((m) => m.entries[0]?.memoryId === m.id && m.entries[0]?.id !== m.id)
      ).toBe(true);
      await left.query(
        "alter table agent_schedule_entries add constraint reject_test_entry check (assignee <> 'Rejected')"
      );
      await expect(
        store.saveScheduleMemories([input("2026-07", "Changed"), input("2026-08", "Rejected")])
      ).rejects.toThrow();
      expect(
        (
          await store.searchScheduleEntries({
            profileName: "helper",
            source: input("2026-07").source
          })
        ).every((e) => e.assignee === "Original")
      ).toBe(true);
      const results = await Promise.allSettled([
        store.saveScheduleMemories([input("2026-07", "Left"), input("2026-08", "Left")]),
        new PostgresAgentMemoryStore(right).saveScheduleMemories([
          input("2026-07", "Right"),
          input("2026-08", "Right")
        ])
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      const saved = await store.searchScheduleEntries({
        profileName: "helper",
        source: input("2026-07").source
      });
      expect(saved).toHaveLength(3);
      expect(saved.find((m) => m.serviceDate === "2026-07-01")?.assignee).toBe(
        saved.find((m) => m.serviceDate === "2026-08-01")?.assignee
      );
      expect(saved.find((m) => m.serviceDate === "2026-09-01")?.assignee).toBe("Original");
      expect(new Set(saved.map((e) => e.id)).size).toBe(3);
    } finally {
      await environment.cleanup();
    }
  });
});
