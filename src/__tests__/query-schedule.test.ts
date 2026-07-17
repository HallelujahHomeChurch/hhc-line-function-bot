import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { activeTaskFromResult } from "../agent/active-task.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { createSaveScheduleHandler } from "../functions/schedule-memory.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
import { InMemorySessionStore } from "../state/session-store.js";
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

function notionSchedulePage(
  id: string,
  date: string,
  meeting: string,
  role: string,
  person: string
) {
  return {
    id,
    properties: {
      日期: { type: "date", date: { start: date } },
      聚會: { type: "rich_text", rich_text: [{ plain_text: meeting }] },
      角色: { type: "rich_text", rich_text: [{ plain_text: role }] },
      同工: { type: "rich_text", rich_text: [{ plain_text: person }] }
    }
  };
}

function scheduleTask(result: Awaited<ReturnType<ReturnType<typeof createQueryScheduleHandler>>>) {
  return activeTaskFromResult(
    "query_schedule",
    result,
    new Date("2026-07-12T00:00:00.000Z"),
    60_000
  );
}

describe("query_schedule", () => {
  it("asks for a domain only when both schedule resolvers have matching data", async () => {
    const now = () => new Date("2026-07-15T00:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now });
    await memoryStore.saveScheduleMemory({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      scheduleType: "morning_prayer_family",
      title: "晨更家族服事表",
      originalText: "7/21二黃弘家族1",
      entries: [
        {
          serviceDate: "2026-07-21",
          meetingName: "晨更",
          role: "服事家族",
          assignee: "黃弘家族1"
        }
      ]
    });
    const scheduleStore = new InMemoryScheduleStore();
    await scheduleStore.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "media-0721",
      serviceDate: "2026-07-21",
      meeting: "晨更",
      role: "音控",
      assignee: "資恆"
    });
    const sessionStore = new InMemorySessionStore({ now });
    const query = createQueryScheduleHandler({
      memoryStore,
      scheduleStore,
      sessionStore,
      now,
      requestIdFactory: () => "resolution-1",
      timeZone: "Asia/Taipei"
    });

    const result = await query({ query: "7/21晨更服事" }, context("7/21晨更服事"));

    expect(result.agentResult).toMatchObject({
      status: "ambiguous",
      clarification: { choices: ["影視團隊服事", "晨更家族服事"] }
    });
    await expect(
      sessionStore.findPendingResolution({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({
      capability: "query_schedule",
      groundedArguments: expect.objectContaining({ specificDate: "2026-07-21" })
    });
  });

  it("clarifies a generic next-service request when multiple schedule domains match", async () => {
    const now = () => new Date("2026-07-15T00:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now });
    await memoryStore.saveScheduleMemory({
      profileName: "helper",
      source: { type: "user", userId: "U1" },
      scheduleType: "morning_prayer_family",
      title: "晨更家族服事表",
      originalText: "7/21二黃弘家族1",
      entries: [
        {
          serviceDate: "2026-07-21",
          meetingName: "晨更",
          role: "服事家族",
          assignee: "黃弘家族1"
        }
      ]
    });
    const scheduleStore = new InMemoryScheduleStore();
    await scheduleStore.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "media-0717",
      serviceDate: "2026-07-17",
      meeting: "晨更",
      role: "音控",
      assignee: "資恆"
    });
    const sessionStore = new InMemorySessionStore({ now });
    const query = createQueryScheduleHandler({
      memoryStore,
      scheduleStore,
      sessionStore,
      now,
      requestIdFactory: () => "resolution-generic",
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "下一場服事", dateIntent: "next_meeting" },
      context("下一場服事", { type: "user", userId: "U1" })
    );

    expect(result.agentResult).toMatchObject({
      status: "ambiguous",
      clarification: { choices: ["影視團隊服事", "晨更家族服事"] }
    });
    expect(result.replyText).not.toContain("資恆");
    expect(result.replyText).not.toContain("黃弘家族1");
  });

  it("uses role evidence to query only the media schedule resolver", async () => {
    const scheduleStore = new InMemoryScheduleStore();
    await scheduleStore.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "media-role",
      serviceDate: "2026-07-21",
      meeting: "晨更",
      role: "音控",
      assignee: "資恆"
    });
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query({ query: "晨更音控是誰" }, context("晨更音控是誰"));

    expect(result.replyText).toContain("音控：資恆");
    expect(result.agentResult?.anchors).toMatchObject({ domainKey: "media_team_service" });
  });

  it("skips a same-day meeting after its configured end time in the read model", async () => {
    const schedules = new InMemoryScheduleStore();
    for (const [serviceDate, meeting, assignee] of [
      ["2026-07-14", "晨更", "已結束同工"],
      ["2026-07-17", "晨更", "下一場同工"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: `${serviceDate}-${meeting}`,
        serviceDate,
        meeting,
        role: "音控",
        assignee
      });
    }
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-14T08:40:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "下一場服事", dateIntent: "next_meeting" },
      context("下一場服事")
    );

    expect(result.replyText).toContain("7月17日");
    expect(result.replyText).toContain("下一場同工");
    expect(result.replyText).not.toContain("已結束同工");
  });

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
    expect(mediaResult.agentResult).toMatchObject({
      status: "success",
      anchors: {
        date: "2026-07-18",
        meeting: "主日",
        sourceKeys: ["media_team_service_schedule"]
      },
      entities: [expect.objectContaining({ type: "role", label: "音控" })]
    });
    expect(roleResult.replyText).toBe("音控：Ray");
  });

  it("keeps a follow-up scoped to the canonical schedule source", async () => {
    const schedules = new InMemoryScheduleStore();
    for (const item of [
      { sourceKey: "media_team_service_schedule", assignee: "Ray" },
      { sourceKey: "other_team_schedule", assignee: "Wrong Person" }
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: item.sourceKey,
        origin: "notion",
        externalId: `${item.sourceKey}-1`,
        serviceDate: "2026-07-18",
        meeting: "主日",
        role: "音控",
        assignee: item.assignee
      });
    }
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });
    const first = await query(
      { query: "下一場影視團隊服事表", dateIntent: "next_meeting" },
      context("下一場影視團隊服事表")
    );
    const followUp = await query(
      { query: "音控是誰", date: "2026-07-18", role: "音控" },
      {
        ...context("音控是誰"),
        activeTask: scheduleTask(first)
      }
    );

    expect(followUp.replyText).toBe("音控：Ray");
    expect(followUp.replyText).not.toContain("Wrong Person");
  });

  it("keeps date and meeting context when a focused role spans multiple meetings", async () => {
    const schedules = new InMemoryScheduleStore();
    for (const [date, meeting, assignee] of [
      ["2026-07-15", "主日", "Ray"],
      ["2026-07-16", "晨更", "家睿"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: `${date}-${meeting}`,
        serviceDate: date,
        meeting,
        role: "音控",
        assignee
      });
    }
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "接下來音控是誰", dateIntent: "upcoming", role: "音控" },
      context("接下來音控是誰")
    );

    expect(result.replyText).toBe("7月15日 主日｜音控：Ray\n7月16日 晨更｜音控：家睿");
  });

  it("creates canonical active-task evidence when live Notion supplies the result", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi
        .fn()
        .mockResolvedValue([
          notionSchedulePage("page-live-1", "2026-07-14", "晨更", "音控", "資恆"),
          notionSchedulePage("page-live-2", "2026-07-14", "晨更", "導播", "莘凌")
        ])
    };
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: new InMemoryScheduleStore(),
      notion,
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "下一場影視團隊服事表", dateIntent: "next_meeting" },
      context("下一場影視團隊服事表")
    );

    expect(result.agentResult).toMatchObject({
      status: "success",
      anchors: {
        date: "2026-07-14",
        meeting: "晨更",
        sourceKeys: ["media_team_service_schedule"]
      },
      entities: expect.arrayContaining([
        expect.objectContaining({ type: "role", label: "音控" }),
        expect.objectContaining({ type: "role", label: "導播" })
      ])
    });
  });

  it("normalizes a production-shaped live Notion roster into a structured result", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi
        .fn()
        .mockResolvedValue([
          notionSchedulePage(
            "page-live-roster",
            "2026-07-14",
            "7月14日(二) 晨更",
            "",
            ["音控: 資恆", "導播: 莘凌", "前攝影: 姵穎,佳美"].join("\n")
          )
        ])
    };
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      notion,
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "下一場影視團隊服事表", dateIntent: "next_meeting" },
      context("下一場影視團隊服事表")
    );

    expect(result.replyText).toContain("前攝影：姵穎,佳美");
    expect(result.agentResult).toMatchObject({
      status: "success",
      replyText: result.replyText,
      anchors: {
        date: "2026-07-14",
        meeting: "7月14日(二) 晨更",
        domainKey: "media_team_service",
        sourceKeys: ["media_team_service_schedule"]
      },
      entities: expect.arrayContaining([
        expect.objectContaining({ type: "role", label: "前攝影" }),
        expect.objectContaining({ type: "role", label: "導播" })
      ]),
      supportedOperations: ["continue", "refine", "advance"],
      replyData: {
        kind: "schedule",
        records: expect.arrayContaining([
          expect.objectContaining({ role: "前攝影", people: "姵穎,佳美" })
        ])
      }
    });
  });

  it("resolves an unambiguous partial role through a result entity alias", async () => {
    const schedules = new InMemoryScheduleStore();
    await schedules.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "page-front-camera",
      serviceDate: "2026-07-14",
      meeting: "7月14日(二) 晨更",
      role: "前攝影",
      assignee: "姵穎"
    });
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "攝影是誰", date: "2026-07-14", limit: 1 },
      context("攝影是誰")
    );

    expect(result.replyText).toContain("前攝影：姵穎");
    expect(result.agentResult).toMatchObject({
      status: "success",
      entities: [
        {
          type: "role",
          key: "前攝影",
          label: "前攝影",
          aliases: expect.arrayContaining(["攝影"])
        }
      ]
    });
  });

  it("returns controlled ambiguity when a partial role matches multiple result entities", async () => {
    const schedules = new InMemoryScheduleStore();
    for (const [role, assignee] of [
      ["前攝影", "姵穎"],
      ["後攝影", "佳美"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: `page-${role}`,
        serviceDate: "2026-07-14",
        meeting: "7月14日(二) 晨更",
        role,
        assignee
      });
    }
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "攝影是誰", date: "2026-07-14", limit: 1 },
      context("攝影是誰")
    );

    expect(result.agentResult).toMatchObject({
      status: "ambiguous",
      clarification: {
        prompt: expect.stringContaining("攝影"),
        choices: ["前攝影", "後攝影"]
      }
    });
    expect(result.replyText).not.toContain("姵穎");
    expect(result.replyText).not.toContain("佳美");
  });

  it("uses an unlisted role focus inside a canonical live Notion schedule", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi
        .fn()
        .mockResolvedValue([
          notionSchedulePage("page-live-1", "2026-07-14", "晨更", "音控", "資恆"),
          notionSchedulePage("page-live-2", "2026-07-14", "晨更", "導播", "莘凌")
        ])
    };
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: new InMemoryScheduleStore(),
      notion,
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "導播是誰", date: "2026-07-14", meeting: "晨更" },
      {
        ...context("導播是誰"),
        activeTask: {
          version: 1,
          capability: "query_schedule",
          anchors: { date: "2026-07-14", meeting: "晨更" },
          entities: [
            { type: "role", key: "音控", label: "音控" },
            { type: "role", key: "導播", label: "導播" }
          ],
          supportedOperations: ["continue", "refine", "advance"],
          createdAt: "2026-07-13T00:00:00.000Z",
          expiresAt: "2026-07-13T00:01:00.000Z"
        }
      }
    );

    expect(result.replyText).toContain("導播：莘凌");
    expect(result.replyText).not.toContain("音控：資恆");
  });

  it("advances to the next schedule group after the canonical result", async () => {
    const schedules = new InMemoryScheduleStore();
    for (const [serviceDate, assignee] of [
      ["2026-07-18", "Ray"],
      ["2026-07-25", "Next Ray"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: `page-${serviceDate}`,
        serviceDate,
        meeting: "主日",
        role: "音控",
        assignee
      });
    }
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });
    const first = await query(
      { query: "下一場影視團隊服事表", dateIntent: "next_meeting" },
      context("下一場影視團隊服事表")
    );
    const next = await query(
      { query: "那下一場呢", dateIntent: "next_meeting" },
      {
        ...context("那下一場呢"),
        activeTask: scheduleTask(first)
      }
    );

    expect(next.replyText).toContain("7月25日");
    expect(next.replyText).toContain("Next Ray");
    expect(next.replyText).not.toContain("7月18日");
  });

  it("limits next-meeting results to one meeting when two meetings share a date", async () => {
    const schedules = new InMemoryScheduleStore();
    for (const [meeting, role, assignee] of [
      ["A 晨更", "音控", "資恆"],
      ["B 晨更", "導播", "不應出現"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: `page-${meeting}`,
        serviceDate: "2026-07-14",
        meeting,
        role,
        assignee
      });
    }
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "下一場影視團隊服事表", dateIntent: "next_meeting" },
      context("下一場影視團隊服事表")
    );

    expect(result.replyText).toContain("【A 晨更】");
    expect(result.replyText).toContain("音控：資恆");
    expect(result.replyText).not.toContain("B 晨更");
    expect(result.replyText).not.toContain("不應出現");
    expect(result.agentResult).toMatchObject({
      anchors: {
        date: "2026-07-14",
        meeting: "A 晨更"
      },
      entities: [expect.objectContaining({ type: "role", label: "音控" })]
    });
  });

  it("treats a complete next-meeting role question as current, not an advance", async () => {
    const schedules = new InMemoryScheduleStore();
    for (const [serviceDate, assignee] of [
      ["2026-07-14", "姵穎"],
      ["2026-07-21", "下一週同工"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: `page-${serviceDate}`,
        serviceDate,
        meeting: "晨更",
        role: "前攝影",
        assignee
      });
    }
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: schedules,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await query(
      { query: "下一場服事表的前攝影是誰", dateIntent: "next_meeting" },
      {
        ...context("下一場服事表的前攝影是誰"),
        activeTask: {
          version: 1,
          capability: "query_schedule",
          anchors: {
            date: "2026-07-14",
            meeting: "晨更",
            sourceKeys: ["media_team_service_schedule"]
          },
          entities: [],
          references: { sourceKeys: ["media_team_service_schedule"] },
          supportedOperations: ["continue", "refine", "advance"],
          createdAt: "2026-07-13T00:00:00.000Z",
          expiresAt: "2026-07-13T00:01:00.000Z"
        }
      }
    );

    expect(result.replyText).toContain("前攝影：姵穎");
    expect(result.replyText).not.toContain("下一週同工");
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
    expect(result.agentResult).toMatchObject({
      status: "success",
      replyText: result.replyText,
      anchors: {
        date: expect.stringMatching(/-07-19$/u),
        meeting: "為耶穌舉牌"
      },
      entities: [expect.objectContaining({ type: "role", label: "服事家族" })],
      supportedOperations: ["continue", "refine", "advance"]
    });
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

    expect(result.replyText).toBe("投影：知樂");
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

  it("returns a not-found envelope while preserving schedule recovery replies", async () => {
    const query = createQueryScheduleHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      scheduleStore: new InMemoryScheduleStore()
    });

    const result = await query({ query: "主日服事", date: "2099-01-01" }, context("主日服事"));

    expect(result.agentResult).toEqual({
      status: "not_found",
      replyText: result.replyText,
      quickReplies: result.quickReplies
    });
    expect(result.quickReplies?.map((item) => item.label)).toEqual(["下一場", "本週", "主日"]);
  });

  it("aggregates saved and synchronized schedule results into one structured result", async () => {
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now });
    await memoryStore.saveScheduleMemory({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      visibility: "profile",
      scheduleType: "custom_service_schedule",
      title: "主日接待",
      originalText: "7/19 主日接待",
      entries: [
        {
          serviceDate: "2026-07-19",
          meetingName: "主日",
          role: "招待",
          assignee: "保存同工"
        }
      ],
      expiresAt: "2027-07-13T00:00:00.000Z"
    });
    const schedules = new InMemoryScheduleStore();
    await schedules.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "page-combined",
      serviceDate: "2026-07-19",
      meeting: "主日",
      role: "音控",
      assignee: "同步同工"
    });
    const query = createQueryScheduleHandler({ memoryStore, scheduleStore: schedules, now });

    const result = await query(
      { query: "", date: "2026-07-19", meeting: "主日" },
      context("查7月19日主日服事")
    );

    expect(result.replyText).toContain("主日：保存同工");
    expect(result.replyText).toContain("音控：同步同工");
    expect(result.agentResult).toMatchObject({
      status: "success",
      entities: expect.arrayContaining([
        expect.objectContaining({ type: "role", label: "招待" }),
        expect.objectContaining({ type: "role", label: "音控" })
      ]),
      supportedOperations: ["continue", "refine", "advance"]
    });
    expect(result.agentResult).toMatchObject({
      anchors: {
        date: "2026-07-19",
        meeting: "主日"
      },
      entities: expect.arrayContaining([
        expect.objectContaining({ type: "role", label: "招待" }),
        expect.objectContaining({ type: "role", label: "音控" })
      ])
    });
  });

  it("preserves ambiguity when partial role candidates come from different schedule sources", async () => {
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now });
    await memoryStore.saveScheduleMemory({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      visibility: "profile",
      scheduleType: "custom_service_schedule",
      title: "攝影服事",
      originalText: "7/19 攝影服事",
      entries: [
        {
          serviceDate: "2026-07-19",
          meetingName: "主日",
          role: "前攝影",
          assignee: "前方同工"
        }
      ],
      expiresAt: "2027-07-13T00:00:00.000Z"
    });
    const schedules = new InMemoryScheduleStore();
    await schedules.upsertItem({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      origin: "notion",
      externalId: "page-back-camera",
      serviceDate: "2026-07-19",
      meeting: "主日",
      role: "後攝影",
      assignee: "後方同工"
    });
    const query = createQueryScheduleHandler({ memoryStore, scheduleStore: schedules, now });

    const result = await query(
      { query: "攝影是誰", date: "2026-07-19", meeting: "主日" },
      context("攝影是誰")
    );

    expect(result.agentResult).toMatchObject({
      status: "ambiguous",
      clarification: { choices: ["前攝影", "後攝影"] }
    });
    expect(result.replyText).not.toContain("前方同工");
    expect(result.replyText).not.toContain("後方同工");
  });
});
