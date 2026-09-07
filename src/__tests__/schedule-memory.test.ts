import { readTestMeetingOccurrences } from "../testing/meeting-occurrences.js";
import { describe, expect, it } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import {
  createQueryScheduleMemoryHandler,
  createSaveScheduleMemoryHandler,
  parseScheduleMemoryContent
} from "../functions/schedule-memory.js";
import type { BotProfileConfig, FunctionHandlerContext } from "../types.js";
import { DEFAULT_SCHEDULE_DOMAINS } from "../schedules/domain-registry.js";

const morningPrayerText = `👉週二、週五〝全教會〞實體晨更，週三、週四各家族線上晨更，隔週四有仙履奇緣。

聚會服事如下👇
週二主題：回應主日
週五主題：當週週報

七/10五黃弘家族2

七/14二中平家族
七/16四仙履奇緣
七/17五世緯家園

七/21二黃弘家族1
七/24五新婦家族

七/28二湧泉家園
七/30四仙履奇緣
七/31五學青媽寶家族

🔆由各家族族長安排服事及帶領，早上6:30晨更。`;

const streetSignText = `👉週日下午為耶穌舉牌服事如下👇

✅7/12共生家園

7/19黃弘家族(音樂人)

7/26新婦家族

8/2學青媽寶家族`;

function profile(): BotProfileConfig {
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
    enabledFunctions: ["save_schedule", "query_schedule"],
    permissionRequiredFunctions: []
  };
}

function context(text = "小哈記住這份晨更服事表"): FunctionHandlerContext {
  return {
    profile: profile(),
    requestId: "req-1",
    requesterIsAdmin: true,
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "C1", userId: "U1" },
      message: { type: "text", text }
    }
  };
}

describe("schedule memory", () => {
  it("parses morning prayer family schedule entries", () => {
    const parsed = parseScheduleMemoryContent({
      content: morningPrayerText,
      now: new Date("2026-07-09T00:00:00.000Z")
    });

    expect(parsed.scheduleType).toBe("morning_prayer_family");
    expect(parsed.title).toBe("晨更家族服事表");
    expect(parsed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceDate: "2026-07-10",
          weekday: "五",
          meetingName: "晨更",
          assignee: "黃弘家族2",
          familyName: "黃弘家族2"
        }),
        expect.objectContaining({
          serviceDate: "2026-07-16",
          weekday: "四",
          meetingName: "仙履奇緣",
          assignee: "仙履奇緣"
        })
      ])
    );
  });

  it("parses street sign service schedule entries", () => {
    const parsed = parseScheduleMemoryContent({
      content: streetSignText,
      now: new Date("2026-07-09T00:00:00.000Z")
    });

    expect(parsed.scheduleType).toBe("street_sign_service");
    expect(parsed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceDate: "2026-07-12",
          meetingName: "為耶穌舉牌",
          assignee: "共生家園"
        }),
        expect.objectContaining({
          serviceDate: "2026-07-19",
          meetingName: "為耶穌舉牌",
          assignee: "黃弘家族",
          notes: "音樂人"
        })
      ])
    );
  });

  it("previews structured schedule memory before saving", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });
    const handler = createSaveScheduleMemoryHandler({
      memoryStore: store,
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });

    const result = await handler({ content: morningPrayerText }, context());

    expect(result.replyText).toContain("我整理到 9 筆晨更家族服事");
    expect(result.replyText).toContain("要保存嗎");
    expect(result.replyText).toContain("2026年7月31日");
    expect(result.replyText).toContain(morningPrayerText);
    expect(result.quickReplies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "保存" }),
        expect.objectContaining({ label: "取消" })
      ])
    );
    await expect(
      store.searchScheduleEntries({ profileName: "helper", source: context().event.source })
    ).resolves.toEqual([]);
  });

  it("shows every persisted entry field in a mutation preview", async () => {
    const save = createSaveScheduleMemoryHandler({ memoryStore: new InMemoryAgentMemoryStore() });
    const preview = await save(
      {
        operation: "add_entry",
        scheduleType: "morning_prayer_family",
        entry: {
          serviceDate: "2026-07-17",
          weekday: "五",
          meetingName: "晨更",
          role: "帶領",
          assignee: "合成同工",
          familyName: "合成家族",
          notes: "完整備註"
        }
      },
      context()
    );
    expect(preview.writePhase).toBe("preview");
    for (const field of [
      "2026年7月17日",
      "（五）",
      "晨更",
      "帶領",
      "合成同工",
      "合成家族",
      "完整備註"
    ])
      expect(preview.replyText).toContain(field);
  });

  it("rejects schedules too large to preview completely", async () => {
    const store = new InMemoryAgentMemoryStore();
    const save = createSaveScheduleMemoryHandler({ memoryStore: store });
    const content = morningPrayerText + "\n" + "備註".repeat(13_000);
    const result = await save({ content }, context());
    expect(result.writePhase).toBeUndefined();
    expect(result.writePreparation).toBe("needs_input");
    expect(result.quickReplies).toBeUndefined();
  });

  it("rejects a preview after its schedule domain revision changes", async () => {
    const store = new InMemoryAgentMemoryStore();
    const handler = createSaveScheduleMemoryHandler({ memoryStore: store });
    const result = await handler(
      {
        content: morningPrayerText,
        domainKey: "morning_prayer_family",
        domainRevision: "old-revision",
        confirm: true
      },
      {
        ...context(),
        profile: {
          ...profile(),
          schedulePolicy: { meetingReferences: [], domains: DEFAULT_SCHEDULE_DOMAINS }
        }
      }
    );

    expect(result.replyText).toContain("設定已更新");
    await expect(store.listScheduleMemories({ profileName: "helper", limit: 10 })).resolves.toEqual(
      []
    );
  });

  it("enforces the domain write policy before parsing content", async () => {
    const handler = createSaveScheduleMemoryHandler({
      memoryStore: new InMemoryAgentMemoryStore()
    });
    const result = await handler(
      { content: "7/21 音控：Ray", domainKey: "media_team_service", confirm: true },
      {
        ...context(),
        profile: {
          ...profile(),
          schedulePolicy: { meetingReferences: [], domains: DEFAULT_SCHEDULE_DOMAINS }
        }
      }
    );
    expect(result.replyText).toContain("只能查詢");
  });

  it("saves a new existing-schema domain without a handler or router branch", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({ memoryStore: store });
    const query = createQueryScheduleMemoryHandler({
      readMeetingOccurrences: readTestMeetingOccurrences,
      memoryStore: store,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    const ctx = {
      ...context("保存兒童主日服事"),
      profile: {
        ...profile(),
        schedulePolicy: { meetingReferences: [], domains: DEFAULT_SCHEDULE_DOMAINS }
      }
    };
    const saved = await save({ content: "7/26 兒童主日 主領：Ray", confirm: true }, ctx);
    const found = await query(
      { query: "兒童主日", scheduleType: "children_sunday", dateIntent: "next_meeting" },
      ctx
    );

    expect(saved.replyText).toContain("已保存 1 筆");
    expect(found.replyText).toContain("主領：Ray");
  });

  it("saves and queries schedule entries by type without mixing service schedules", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({
      memoryStore: store,
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });
    const query = createQueryScheduleMemoryHandler({
      readMeetingOccurrences: readTestMeetingOccurrences,
      memoryStore: store
    });

    await save(
      { content: morningPrayerText, scheduleType: "morning_prayer_family", confirm: true },
      context()
    );
    await save(
      { content: streetSignText, scheduleType: "street_sign_service", confirm: true },
      context("小哈記住這份舉牌服事表")
    );

    const streetSign = await query(
      { query: "7/19舉牌", scheduleType: "street_sign_service" },
      context("小哈 7/19舉牌誰服事")
    );
    const morningPrayer = await query(
      { query: "7/17晨更", scheduleType: "morning_prayer_family" },
      context("小哈 7/17晨更誰服事")
    );

    expect(streetSign.replyText).toContain("7月19日");
    expect(streetSign.replyText).toContain("黃弘家族");
    expect(streetSign.replyText).not.toContain("世緯家園");
    expect(morningPrayer.replyText).toContain("7月17日");
    expect(morningPrayer.replyText).toContain("世緯家園");
    expect(morningPrayer.replyText).not.toContain("黃弘家族");
  });

  it("keeps saved schedules for one year", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({
      memoryStore: store,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    await save(
      { content: "7/17五世緯家園", scheduleType: "morning_prayer_family", confirm: true },
      context()
    );

    const schedules = await store.listScheduleMemories({ profileName: "helper", limit: 10 });
    expect(schedules[0]?.expiresAt).toBe("2027-07-10T00:00:00.000Z");
    expect(schedules[0]?.visibility).toBe("profile");
  });

  it("replaces the active schedule for the same type and month", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({ memoryStore: store });

    await save(
      { content: "7/17五世緯家園", scheduleType: "morning_prayer_family", confirm: true },
      context()
    );
    await save(
      { content: "7/18六新婦家族", scheduleType: "morning_prayer_family", confirm: true },
      context()
    );

    await expect(store.listScheduleMemories({ profileName: "helper" })).resolves.toHaveLength(1);
    await expect(
      store.searchScheduleEntries({ profileName: "helper", source: context().event.source })
    ).resolves.toEqual([
      expect.objectContaining({ serviceDate: "2026-07-18", assignee: "新婦家族" })
    ]);
  });

  it("states which canonical schedule will be replaced in the preview", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({ memoryStore: store });
    await save(
      {
        title: "七月份家族晨更安排",
        content: "7/17五世緯家園",
        scheduleType: "morning_prayer_family",
        confirm: true
      },
      context()
    );

    const preview = await save(
      {
        content: "7/18六新婦家族",
        scheduleType: "morning_prayer_family"
      },
      context()
    );

    expect(preview.replyText).toContain("將取代現有的「七月份家族晨更安排」");
  });

  it("previews and confirms a single schedule entry update", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({ memoryStore: store });
    await save(
      { content: "7/17五世緯家園", scheduleType: "morning_prayer_family", confirm: true },
      context()
    );

    const preview = await save(
      {
        operation: "update_entry",
        targetQuery: "世緯家園",
        changes: { serviceDate: "2026-07-18" }
      },
      context("小哈把世緯家園改到7/18")
    );
    expect(preview.replyText).toContain("7月17日");
    expect(preview.replyText).toContain("7月18日");
    expect(preview.replyText).toContain("要套用嗎");

    await save(
      {
        operation: "update_entry",
        targetQuery: "世緯家園",
        changes: { serviceDate: "2026-07-18" },
        confirm: true
      },
      context("確認")
    );

    await expect(
      store.searchScheduleEntries({ profileName: "helper", source: context().event.source })
    ).resolves.toEqual([
      expect.objectContaining({ serviceDate: "2026-07-18", assignee: "世緯家園" })
    ]);
  });

  it("allows granted writers to replace or add but reserves update and delete for admins", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({ memoryStore: store });
    await save(
      { content: "7/17五世緯家園", scheduleType: "morning_prayer_family", confirm: true },
      context()
    );
    const writerContext = { ...context(), requesterIsAdmin: false };

    await expect(
      save(
        {
          operation: "update_entry",
          targetQuery: "世緯家園",
          changes: { serviceDate: "2026-07-18" }
        },
        writerContext
      )
    ).resolves.toMatchObject({ replyText: expect.stringContaining("只有管理員") });
    await expect(
      save({ operation: "delete_entry", targetQuery: "世緯家園" }, writerContext)
    ).resolves.toMatchObject({ replyText: expect.stringContaining("只有管理員") });
    await expect(
      save(
        {
          operation: "add_entry",
          scheduleType: "morning_prayer_family",
          entry: {
            serviceDate: "2026-07-24",
            meetingName: "晨更",
            assignee: "新婦家族"
          }
        },
        writerContext
      )
    ).resolves.toMatchObject({ replyText: expect.stringContaining("請確認這筆新服事") });
  });

  it("previews and confirms adding and deleting schedule entries", async () => {
    const store = new InMemoryAgentMemoryStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    const save = createSaveScheduleMemoryHandler({ memoryStore: store });
    await save(
      { content: "7/17五世緯家園", scheduleType: "morning_prayer_family", confirm: true },
      context()
    );

    const addPreview = await save(
      {
        operation: "add_entry",
        scheduleType: "morning_prayer_family",
        entry: {
          serviceDate: "2026-07-24",
          meetingName: "晨更",
          assignee: "新婦家族",
          familyName: "新婦家族"
        }
      },
      context("小哈新增7/24晨更新婦家族")
    );
    expect(addPreview.replyText).toContain("要新增嗎");
    await save(
      {
        operation: "add_entry",
        scheduleType: "morning_prayer_family",
        entry: {
          serviceDate: "2026-07-24",
          meetingName: "晨更",
          assignee: "新婦家族",
          familyName: "新婦家族"
        },
        confirm: true
      },
      context("確認")
    );

    const deletePreview = await save(
      { operation: "delete_entry", targetQuery: "世緯家園" },
      context("小哈刪除世緯家園7/17晨更")
    );
    expect(deletePreview.replyText).toContain("要刪除嗎");
    await save(
      { operation: "delete_entry", targetQuery: "世緯家園", confirm: true },
      context("確認")
    );

    await expect(
      store.searchScheduleEntries({ profileName: "helper", source: context().event.source })
    ).resolves.toEqual([
      expect.objectContaining({ serviceDate: "2026-07-24", assignee: "新婦家族" })
    ]);
  });
});

describe("agent structured schedule drafts", () => {
  const entries = [
    {
      serviceDate: "2026-09-13",
      meetingName: "為耶穌舉牌",
      assignee: "合成甲家園",
      notes: "需要更改請自行交換"
    },
    { serviceDate: "2026-10-04", meetingName: "為耶穌舉牌", assignee: "合成乙組" }
  ];
  const content =
    "轉貼公告：週日下午為耶穌舉牌。9月13日合成甲家園、10月4日合成乙組。PS.需要更改請自行交換；另請記得帶水。";
  it("previews organized entries from noisy source and atomically saves all months only after confirmation", async () => {
    const memoryStore = new InMemoryAgentMemoryStore();
    const handler = createSaveScheduleMemoryHandler({ memoryStore });
    const ctx = { ...context(), agentTool: true };
    const args = { domainKey: "street_sign_service", content, entries };
    const preview = await handler(args, ctx);
    expect(preview.writePhase).toBe("preview");
    expect(preview.replyText).toContain("合成甲家園");
    expect(preview.replyText).toContain("2026年10月4日");
    expect(preview.replyText).toContain(content);
    expect(await memoryStore.listScheduleMemories({ profileName: "helper" })).toHaveLength(0);
    expect((await handler({ ...args, confirm: true }, ctx)).writePhase).toBe("commit");
    const saved = await memoryStore.listScheduleMemories({ profileName: "helper" });
    expect(saved.map((row) => row.periodKey).sort()).toEqual(["2026-09", "2026-10"]);
    expect(
      saved
        .flatMap((row) => row.entries)
        .map((row) => row.assignee)
        .sort()
    ).toEqual(["合成乙組", "合成甲家園"].sort());
  });
  it("returns actionable validation without dropping structured data into the raw parser", async () => {
    const handler = createSaveScheduleMemoryHandler({
      memoryStore: new InMemoryAgentMemoryStore()
    });
    const result = await handler(
      {
        domainKey: "street_sign_service",
        content,
        entries: [{ ...entries[0], serviceDate: "2026-02-30" }]
      },
      { ...context(), agentTool: true }
    );
    expect(result.writePreparation).toBe("needs_input");
    expect(result.replyText).toContain("2026-02-30");
  });
  it("rejects unknown domain identifiers instead of silently saving a custom schedule", async () => {
    const handler = createSaveScheduleMemoryHandler({
      memoryStore: new InMemoryAgentMemoryStore()
    });
    const result = await handler(
      { domainKey: "invented_domain", content: "9/13 合成甲組" },
      { ...context(), agentTool: true }
    );
    expect(result.writePreparation).toBe("needs_input");
    expect(result.writePhase).toBeUndefined();
  });
});

it("cannot preview an unregistered fallback type when the configured registry has no custom domain", async () => {
  const handler = createSaveScheduleMemoryHandler({ memoryStore: new InMemoryAgentMemoryStore() });
  for (const key of ["street_sign_service", "media_team_service"]) {
    const ctx = context();
    ctx.profile.schedulePolicy = {
      domains: DEFAULT_SCHEDULE_DOMAINS.filter((domain) => domain.key === key)
    } as NonNullable<BotProfileConfig["schedulePolicy"]>;
    const result = await handler(
      {
        content: "9/13 合成甲組",
        entries: [{ serviceDate: "2026-09-13", meetingName: "其他活動", assignee: "合成甲組" }]
      },
      { ...ctx, agentTool: true }
    );
    expect(result.writePhase).toBeUndefined();
    expect(result.writePreparation).toBe("needs_input");
  }
});
