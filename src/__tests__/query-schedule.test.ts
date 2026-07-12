import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { createSaveScheduleHandler } from "../functions/schedule-memory.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  LineSource,
  NotionDatabaseClient
} from "../types.js";

function context(
  text = "小哈查服事表",
  source: LineSource = { type: "group", groupId: "C1", userId: "U1" }
): FunctionHandlerContext {
  return {
    requestId: "req-1",
    profile: {
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
      enabledFunctions: ["query_schedule", "save_schedule"]
    } satisfies BotProfileConfig,
    event: {
      type: "message",
      source,
      message: { type: "text", text }
    }
  };
}

describe("query_schedule", () => {
  it("answers media-team and role questions without full-text matching the whole sentence", async () => {
    const schedules = new InMemoryScheduleStore();
    await schedules.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "page-media-1",
      serviceDate: "2026-07-18",
      meeting: "主日",
      role: "音控",
      assignee: "Ray"
    });
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const mediaResult = await query(
      { query: "給我下一場影視團隊的服事表" },
      context("給我下一場影視團隊的服事表")
    );
    const roleResult = await query(
      { query: "下一場服事表的音控是誰" },
      context("下一場服事表的音控是誰")
    );

    expect(mediaResult.replyText).toContain("音控：Ray");
    expect(roleResult.replyText).toContain("音控：Ray");
  });

  it("keeps a meaningful residual query for a custom saved schedule title", async () => {
    const now = () => new Date("2026-07-12T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now });
    const save = createSaveScheduleHandler({ memoryStore: store, now });
    const query = createQueryScheduleHandler({ memoryStore: store, now });
    await save(
      {
        title: "青年出隊服事表",
        content: "7/19青年出隊：Ray",
        scheduleType: "custom_service_schedule",
        confirm: true
      },
      context("保存青年出隊服事表")
    );

    const result = await query({ query: "下一場青年出隊服事表" }, context("下一場青年出隊服事表"));

    expect(result.replyText).toContain("青年出隊");
    expect(result.replyText).toContain("Ray");
  });

  it("uses one user-facing function for a saved schedule without exposing its storage", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });
    const save = createSaveScheduleHandler({
      memoryStore: store,
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });
    const query = createQueryScheduleHandler({ memoryStore: store });
    await save(
      { content: "7/19黃弘家族(音樂人)", scheduleType: "street_sign_service", confirm: true },
      context("小哈記住舉牌服事表")
    );

    const result = await query(
      { query: "7/19舉牌", scheduleType: "street_sign_service" },
      context("小哈查7/19舉牌服事")
    );

    expect(result.replyText).toContain("7月19日");
    expect(result.replyText).toContain("黃弘家族");
    expect(result.replyText).not.toMatch(/Notion|Postgres|記憶來源/u);
  });

  it("uses the configured schedule source when a saved schedule has no match", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          properties: {
            日期: { type: "date", date: { start: "2026-07-12" } },
            聚會: { type: "rich_text", rich_text: [{ plain_text: "主日" }] },
            角色: { type: "rich_text", rich_text: [{ plain_text: "投影" }] },
            同工: { type: "rich_text", rich_text: [{ plain_text: "知樂" }] }
          }
        }
      ])
    };
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      notion,
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      timeZone: "Asia/Taipei"
    });

    const result = await query({ query: "主日服事" }, context("小哈查主日服事"));

    expect(result.replyText).toContain("主日");
    expect(result.replyText).toContain("投影：知樂");
    expect(result.replyText).not.toMatch(/Notion|Postgres/u);
  });

  it("queries synchronized schedule rows from the read model before live Notion", async () => {
    const schedules = new InMemoryScheduleStore();
    await schedules.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "page-1",
      serviceDate: "2026-07-12",
      meeting: "主日",
      role: "投影",
      assignee: "知樂"
    });
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([])
    };
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      notion,
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "主日投影服事", dateIntent: "specific_date", specificDate: "2026-07-12" },
      context("小哈查主日投影服事")
    );

    expect(result.replyText).toContain("主日");
    expect(result.replyText).toContain("投影：知樂");
    expect(result.replyText).not.toMatch(/Notion|Postgres/u);
    expect(notion.queryDatabase).not.toHaveBeenCalled();
  });

  it("shares saved schedules across direct and group conversations in the helper profile", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleHandler({ memoryStore: store });
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "unrelated",
          properties: {
            日期: { type: "date", date: { start: "2026-07-12" } },
            聚會: { type: "rich_text", rich_text: [{ plain_text: "主日" }] },
            角色: { type: "rich_text", rich_text: [{ plain_text: "投影" }] },
            同工: { type: "rich_text", rich_text: [{ plain_text: "知樂" }] }
          }
        }
      ])
    };
    const query = createQueryScheduleHandler({
      memoryStore: store,
      notion,
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    await save(
      {
        content: "7/17五世緯家園",
        scheduleType: "morning_prayer_family",
        confirm: true
      },
      context("小哈記住晨更服事表", { type: "user", userId: "Uadmin" })
    );

    const result = await query(
      { query: "下次世緯家園服事是什麼時候", dateIntent: "next_meeting" },
      context("下次世緯家園服事是什麼時候", {
        type: "group",
        groupId: "C2",
        userId: "U2"
      })
    );

    expect(result.replyText).toContain("7月17日");
    expect(result.replyText).toContain("世緯家園");
    expect(result.replyText).not.toContain("知樂");
    expect(notion.queryDatabase).not.toHaveBeenCalled();
  });

  it("filters the next street-sign service by family", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleHandler({ memoryStore: store });
    const query = createQueryScheduleHandler({
      memoryStore: store,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    await save(
      {
        content: "7/12共生家園\n7/19中平家族\n7/26新婦家族",
        scheduleType: "street_sign_service",
        confirm: true
      },
      context()
    );

    const result = await query(
      {
        query: "下一次中平家族什麼時候舉牌",
        dateIntent: "next_meeting",
        scheduleType: "street_sign_service"
      },
      context("下一次中平家族什麼時候舉牌")
    );

    expect(result.replyText).toContain("7月19日");
    expect(result.replyText).toContain("中平家族");
    expect(result.replyText).not.toContain("共生家園");
  });

  it("lists saved schedule titles without expanding their contents", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleHandler({ memoryStore: store });
    const query = createQueryScheduleHandler({ memoryStore: store });
    await save(
      {
        title: "七月份家族晨更安排",
        content: "7/17五世緯家園",
        scheduleType: "morning_prayer_family",
        confirm: true
      },
      context()
    );

    const result = await query(
      { query: "現在有存的服事表有哪些" },
      context("現在有存的服事表有哪些")
    );

    expect(result.replyText).toContain("七月份家族晨更安排");
    expect(result.replyText).not.toContain("世緯家園");
  });
});
