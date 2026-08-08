import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadWeeklyPaper } from "../capabilities/download-weekly-paper.js";

const ASSET_ID = "0123456789abcdef0123456789abcdef";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      issueNumber: 1733,
      issueDate: "2026-08-09",
      locale: "zh-Hant",
      title: "第 1733 期週報",
      subtitle: "HHC Weekly Paper",
      downloadUrl: `/assets/${ASSET_ID}?filename=1733-%E9%80%B1%E5%A0%B1.pdf`,
      downloadFileName: "1733-週報.pdf",
      publishedAt: "2026-08-09T02:00:00.000Z",
      version: 3,
      ...overrides
    },
    meta: {},
    error: null
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("download_weekly_paper", () => {
  it("returns the latest public Weekly Paper as a response-only LINE URI action", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(envelope()));

    const result = await downloadWeeklyPaper({}, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method/api/bulletins/latest?locale=zh-Hant",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) })
    );
    expect(result).toMatchObject({
      ok: true,
      executedAction: "download_weekly_paper",
      agentResult: {
        status: "success",
        anchors: {},
        entities: [],
        supportedOperations: []
      },
      quickReplies: [
        {
          action: {
            type: "uri",
            uri: `https://www.alive.org.tw/assets/${ASSET_ID}?filename=1733-%E9%80%B1%E5%A0%B1.pdf`
          }
        }
      ]
    });
    expect(result.replyText).not.toContain("http");
    const persistableFields = { ...result };
    delete persistableFields.quickReplies;
    expect(JSON.stringify(persistableFields)).not.toContain("alive.org.tw");
  });

  it("accepts the exact-origin absolute URL returned by hhc-web-api", async () => {
    const downloadUrl =
      `https://www.alive.org.tw/assets/${ASSET_ID}` + "?filename=1733-%E9%80%B1%E5%A0%B1.pdf";
    const result = await downloadWeeklyPaper(
      {},
      vi.fn<typeof fetch>().mockResolvedValue(response(envelope({ downloadUrl })))
    );

    expect(result).toMatchObject({
      ok: true,
      agentResult: { status: "success" },
      quickReplies: [{ action: { type: "uri", uri: downloadUrl } }]
    });
  });

  it("uses the exact by-number route and rejects a mismatched issue", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(envelope()))
      .mockResolvedValueOnce(response(envelope({ issueNumber: 1732 })));

    await expect(downloadWeeklyPaper({ issueNumber: 1733 }, fetchImpl)).resolves.toMatchObject({
      ok: true,
      agentResult: { status: "success" }
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method/api/bulletins/by-number/1733?locale=zh-Hant",
      expect.objectContaining({ method: "GET" })
    );
    const mismatch = await downloadWeeklyPaper({ issueNumber: 1733 }, fetchImpl);
    expect(mismatch).toMatchObject({ ok: true, agentResult: { status: "unavailable" } });
    expect(mismatch).not.toHaveProperty("quickReplies");
  });

  it("maps a 404 to not_found and other dependency failures to unavailable", async () => {
    const notFound = vi.fn<typeof fetch>().mockResolvedValue(response({ error: {} }, 404));
    const serverError = vi.fn<typeof fetch>().mockResolvedValue(response({ error: {} }, 503));

    const notFoundResult = await downloadWeeklyPaper({}, notFound);
    const serverErrorResult = await downloadWeeklyPaper({}, serverError);
    expect(notFoundResult).toMatchObject({ ok: true, agentResult: { status: "not_found" } });
    expect(serverErrorResult).toMatchObject({
      ok: true,
      agentResult: { status: "unavailable" }
    });
    expect(notFoundResult).not.toHaveProperty("quickReplies");
    expect(serverErrorResult).not.toHaveProperty("quickReplies");
  });

  it("rejects Dapr redirects without following Location", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://private.example.test/weekly-paper" }
      })
    );

    const result = await downloadWeeklyPaper({}, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "GET", redirect: "error" })
    );
    expect(result).toMatchObject({ ok: true, agentResult: { status: "unavailable" } });
    expect(result).not.toHaveProperty("quickReplies");
  });

  it("enforces a hard request timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        })
    );

    const resultPromise = downloadWeeklyPaper({}, fetchImpl);
    await vi.advanceTimersByTimeAsync(3_001);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      agentResult: { status: "unavailable" }
    });
  });

  it.each([
    ["invalid JSON", new Response("not-json", { status: 200 })],
    ["missing envelope", response({ data: null, meta: {}, error: null })],
    ["non-null envelope error", response({ ...envelope(), error: { code: "failed" } })],
    ["wrong locale", response(envelope({ locale: "en" }))],
    ["missing metadata", response(envelope({ publishedAt: "not-a-date" }))]
  ])("maps malformed public responses to unavailable: %s", async (_name, upstream) => {
    const result = await downloadWeeklyPaper({}, vi.fn<typeof fetch>().mockResolvedValue(upstream));
    expect(result).toMatchObject({ ok: true, agentResult: { status: "unavailable" } });
    expect(result).not.toHaveProperty("quickReplies");
  });

  it.each([
    ["zero", 0],
    ["non-integer", 1733.5],
    ["above int32", 2_147_483_648]
  ])("rejects a latest response with an invalid issue number: %s", async (_name, issueNumber) => {
    const result = await downloadWeeklyPaper(
      {},
      vi.fn<typeof fetch>().mockResolvedValue(response(envelope({ issueNumber })))
    );

    expect(result).toMatchObject({ ok: true, agentResult: { status: "unavailable" } });
    expect(result).not.toHaveProperty("quickReplies");
  });

  it("rejects a canonical URL that exceeds LINE's URI action limit", async () => {
    const downloadUrl = `/assets/${ASSET_ID}?filename=${"a".repeat(1_000)}`;

    const result = await downloadWeeklyPaper(
      {},
      vi.fn<typeof fetch>().mockResolvedValue(response(envelope({ downloadUrl })))
    );

    expect(result).toMatchObject({ ok: true, agentResult: { status: "unavailable" } });
    expect(result).not.toHaveProperty("quickReplies");
  });

  it.each([
    ["external", `https://evil.example/assets/${ASSET_ID}`],
    ["wrong port", `https://www.alive.org.tw:444/assets/${ASSET_ID}`],
    ["wrong protocol", `http://www.alive.org.tw/assets/${ASSET_ID}`],
    ["userinfo", `https://user@www.alive.org.tw/assets/${ASSET_ID}`],
    ["absolute traversal", `https://www.alive.org.tw/junk/../assets/${ASSET_ID}`],
    ["absolute encoded traversal", `https://www.alive.org.tw/junk/%2e%2e/assets/${ASSET_ID}`],
    ["scheme relative", `//evil.example/assets/${ASSET_ID}`],
    ["legacy", `/api/assets/public/${ASSET_ID}`],
    ["encoded path", `/assets/%30${ASSET_ID.slice(1)}`],
    ["traversal", `/assets/${ASSET_ID}/../evil`],
    ["extra segment", `/assets/${ASSET_ID}/large`],
    ["uppercase id", `/assets/${ASSET_ID.toUpperCase()}`],
    ["fragment", `/assets/${ASSET_ID}#private`],
    ["blank filename", `/assets/${ASSET_ID}?filename=`],
    ["duplicate filename", `/assets/${ASSET_ID}?filename=a&filename=b`],
    ["extra query", `/assets/${ASSET_ID}?filename=a&token=secret`]
  ])("rejects a non-canonical Weekly Paper URL: %s", async (_name, downloadUrl) => {
    const result = await downloadWeeklyPaper(
      {},
      vi.fn<typeof fetch>().mockResolvedValue(response(envelope({ downloadUrl })))
    );

    expect(result).toMatchObject({
      ok: true,
      agentResult: { status: "unavailable" }
    });
    expect(result).not.toHaveProperty("quickReplies");
    expect(JSON.stringify(result)).not.toContain(downloadUrl);
  });
});
