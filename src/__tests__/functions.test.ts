import { describe, expect, it, vi } from "vitest";

import { createFindPptSlidesHandler } from "../functions/find-ppt-slides.js";
import { createQueryServiceScheduleHandler } from "../functions/query-service-schedule.js";
import type { GraphDriveClient, NotionDatabaseClient } from "../types.js";

describe("find_ppt_slides", () => {
  it("searches configured drive folder and creates 24 hour anonymous links", async () => {
    const expirations: string[] = [];
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        { id: "1", name: "主日詩歌.pptx", webUrl: "https://example.invalid/1" },
        { id: "2", name: "主日詩歌.pdf", webUrl: "https://example.invalid/2" },
        { id: "3", name: "講章.docx", webUrl: "https://example.invalid/3" }
      ]),
      createSharingLink: vi.fn(async (_driveId, _itemId, expirationDateTime) => {
        expirations.push(expirationDateTime);
        return "https://download.invalid/link";
      })
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      now: () => now
    });

    const result = await handler({
      query: "主日",
      includePdf: true
    });

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("主日詩歌.pptx");
    expect(result.replyText).toContain("主日詩歌.pdf");
    expect(result.replyText).not.toContain("講章.docx");
    expect(expirations).toEqual(["2026-07-05T10:00:00.000Z", "2026-07-05T10:00:00.000Z"]);
  });
});

describe("query_service_schedule", () => {
  it("maps Notion properties from env-style configuration", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "主日聚會" } },
            Role: { type: "title", title: [{ plain_text: "司會" }] },
            Person: { type: "people", people: [{ name: "Ray" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      }
    });

    const result = await handler({ query: "主日司會" });

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("2026-07-05");
    expect(result.replyText).toContain("主日聚會");
    expect(result.replyText).toContain("司會");
    expect(result.replyText).toContain("Ray");
  });

  it("returns a clear empty result when Notion has no matching rows", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      }
    });

    const result = await handler({ query: "不存在的服事" });

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe("查不到符合的服事表。");
  });
});
