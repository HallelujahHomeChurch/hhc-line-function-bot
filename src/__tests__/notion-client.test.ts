import { beforeEach, describe, expect, it, vi } from "vitest";

const notion = vi.hoisted(() => ({
  retrieve: vi.fn(),
  options: vi.fn(),
  query: vi.fn()
}));

vi.mock("@notionhq/client", () => ({
  Client: class {
    constructor(options: unknown) {
      notion.options(options);
    }
    dataSources = {
      retrieve: notion.retrieve,
      query: notion.query
    };
  },
  LogLevel: { ERROR: "error" }
}));

import { createNotionDatabaseClient } from "../clients/notion.js";

describe("Notion database client", () => {
  beforeEach(() => {
    notion.retrieve.mockReset().mockResolvedValue({ id: "database-1" });
    notion.query.mockReset();
  });

  it("follows every next cursor before returning database rows", async () => {
    notion.query
      .mockResolvedValueOnce({
        results: [{ id: "page-1", properties: {} }],
        has_more: true,
        next_cursor: "cursor-2"
      })
      .mockResolvedValueOnce({
        results: [{ id: "page-2", properties: {} }],
        has_more: true,
        next_cursor: "cursor-3"
      })
      .mockResolvedValueOnce({
        results: [{ id: "page-3", properties: {} }],
        has_more: false,
        next_cursor: null
      });
    const client = createNotionDatabaseClient({
      token: "token",
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" }
    });

    const pages = await client.queryDatabase("database-1");

    expect(pages.map((page) => page.id)).toEqual(["page-1", "page-2", "page-3"]);
    expect(notion.query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ start_cursor: "cursor-2" })
    );
    expect(notion.query).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ start_cursor: "cursor-3" })
    );
  });

  it("fails instead of returning a partial page set when the next cursor is missing", async () => {
    notion.query.mockResolvedValue({
      results: [{ id: "page-1", properties: {} }],
      has_more: true,
      next_cursor: null
    });
    const client = createNotionDatabaseClient({
      token: "token",
      databaseId: "database-1",
      properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" }
    });

    await expect(client.queryDatabase("database-1")).rejects.toThrow(
      "notion_pagination_cursor_missing"
    );
  });
});

describe("job-only Notion options", () => {
  it("keeps API defaults but opts job instances into fetch ownership and no retries", () => {
    const config = {
      token: "fixture",
      databaseId: "database",
      properties: { date: "date", meeting: "meeting", role: "role", person: "person" }
    };
    notion.options.mockClear();
    createNotionDatabaseClient(config);
    expect(notion.options.mock.calls[0]?.[0]).not.toHaveProperty("retry");
    expect(notion.options.mock.calls[0]?.[0]).not.toHaveProperty("fetch");
    const fetcher = vi.fn<typeof fetch>();
    const signal = new AbortController().signal;
    createNotionDatabaseClient(config, { signal, fetch: fetcher, noRetry: true });
    expect(notion.options.mock.calls[1]?.[0]).toMatchObject({ fetch: fetcher, retry: false });
  });
  it("does not use data-source fallback after owner cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("job_stopped");
    notion.retrieve.mockReset().mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    notion.query.mockClear();
    const client = createNotionDatabaseClient(
      {
        token: "fixture",
        databaseId: "database",
        properties: { date: "date", meeting: "meeting", role: "role", person: "person" }
      },
      { signal: controller.signal }
    );
    await expect(client.queryDatabase("database")).rejects.toBe(reason);
    expect(notion.query).not.toHaveBeenCalled();
  });
});
