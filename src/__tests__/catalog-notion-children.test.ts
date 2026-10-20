import { describe, expect, it, vi } from "vitest";
import { createNotionKnowledgeClient } from "../clients/notion-knowledge.js";
import { createCatalogNotionFetch } from "../tools/catalog-notion-fetch.js";

describe("job Notion child ownership", () => {
  it("joins already started sibling page reads before returning a failure", async () => {
    const sibling = Promise.withResolvers<Response>();
    const secondStarted = Promise.withResolvers<void>();
    const wire = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.includes("/pages/"))
        return Response.json(
          { object: "error", code: "object_not_found", message: "fixture" },
          { status: 404 }
        );
      if (path.includes("/databases/"))
        return Response.json({ id: "root", data_sources: [{ id: "source" }] });
      if (path.includes("/data_sources/"))
        return Response.json({
          results: [
            { id: "first", properties: {} },
            { id: "second", properties: {} }
          ],
          has_more: false
        });
      if (path.includes("/blocks/first/"))
        return Response.json(
          { object: "error", code: "internal_server_error", message: "fixture" },
          { status: 500 }
        );
      secondStarted.resolve();
      return sibling.promise;
    });
    const owner = createCatalogNotionFetch(new AbortController().signal, wire);
    const client = createNotionKnowledgeClient("fixture", {
      signal: new AbortController().signal,
      fetch: owner.fetch,
      noRetry: true
    });
    let settled = false;
    const work = client.fetchRoot("root").then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    try {
      await secondStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const early = settled;
      sibling.resolve(Response.json({ results: [], has_more: false }));
      expect(await work).toBeInstanceOf(Error);
      expect(early).toBe(false);
      expect(
        wire.mock.calls.filter(([input]) => String(input).includes("/blocks/first/"))
      ).toHaveLength(1);
    } finally {
      sibling.resolve(Response.json({ results: [], has_more: false }));
      await work;
      await owner.close();
    }
  });
});
