import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadWeeklyPaper } from "../capabilities/download-weekly-paper.js";

const lineUserId = `U${"a".repeat(32)}`;
const subjectId = "018f0c1f-18d0-7e81-9f6f-69c456db7003";

function response(data: unknown, status = 200): Response {
  return Response.json(status === 200 ? { data, meta: {}, error: null } : data, { status });
}

function access(
  resolveLineSubject = vi.fn().mockResolvedValue({ bound: true, active: true, subjectId })
) {
  return { lineUserId, profileName: "main", requestId: "request-1", resolveLineSubject };
}

afterEach(() => vi.useRealTimers());

describe("download_weekly_paper", () => {
  it("resolves the linked subject and checks the protected latest bulletin", async () => {
    const resolveLineSubject = vi.fn().mockResolvedValue({ bound: true, active: true, subjectId });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ issueNumber: 1733, locale: "zh-Hant" }));

    const result = await downloadWeeklyPaper({}, fetchImpl, access(resolveLineSubject));

    expect(resolveLineSubject).toHaveBeenCalledWith({ lineUserId, profileName: "main" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method/api/member/bulletins/latest?series=general&locale=zh-Hant",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          "X-HHC-User-ID": subjectId,
          "X-HHC-Auth-Provider": "account-api",
          "X-HHC-Request-ID": "request-1"
        }
      })
    );
    expect(result).toMatchObject({
      ok: true,
      replyText: "第 1733 期週報可在會員頁面查看或下載。",
      quickReplies: [
        { action: { type: "uri", uri: "https://www.alive.org.tw/zh-Hant/literature-ministry" } }
      ],
      agentResult: { status: "success" }
    });
  });

  it("queries an exact issue only through the protected member list", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ items: [{ issueNumber: 1733, locale: "zh-Hant" }] }));

    await expect(
      downloadWeeklyPaper({ issueNumber: 1733 }, fetchImpl, access())
    ).resolves.toMatchObject({
      agentResult: { status: "success" }
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method/api/member/bulletins?series=general&locale=zh-Hant&issueNumber=1733&page=1&pageSize=1"
    );
  });

  it.each([
    [{ bound: false, active: false }, "請先輸入「登入」連結 HHC 帳號，再查看會員週報。"],
    [{ bound: true, active: false }, "此帳號目前沒有會員週報存取權。"]
  ])(
    "denies unavailable linked-account states before HHC data access",
    async (decision, replyText) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const result = await downloadWeeklyPaper(
        {},
        fetchImpl,
        access(vi.fn().mockResolvedValue(decision))
      );

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result).toMatchObject({ replyText, agentResult: { status: "unavailable" } });
      expect(result).not.toHaveProperty("quickReplies");
    }
  );

  it("fails closed when Account subject resolution is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await downloadWeeklyPaper(
      {},
      fetchImpl,
      access(vi.fn().mockRejectedValue(new Error("offline")))
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ agentResult: { status: "unavailable" } });
  });

  it("maps entitlement denial or a missing issue to a non-disclosing result", async () => {
    const result = await downloadWeeklyPaper(
      { issueNumber: 1733 },
      vi.fn<typeof fetch>().mockResolvedValue(response({ error: {} }, 404)),
      access()
    );

    expect(result).toMatchObject({
      replyText: "目前找不到或無法存取這一期週報。",
      agentResult: { status: "not_found" }
    });
    expect(result).not.toHaveProperty("quickReplies");
  });

  it.each([
    ["dependency failure", response({ error: {} }, 503)],
    ["invalid JSON", new Response("not-json")],
    ["wrong locale", response({ issueNumber: 1733, locale: "en" })],
    ["mismatched issue", response({ items: [{ issueNumber: 1732, locale: "zh-Hant" }] })]
  ])("fails closed for %s", async (_name, upstream) => {
    const args = _name === "mismatched issue" ? { issueNumber: 1733 } : {};
    const result = await downloadWeeklyPaper(
      args,
      vi.fn<typeof fetch>().mockResolvedValue(upstream),
      access()
    );
    expect(result).toMatchObject({ agentResult: { status: "unavailable" } });
    expect(result).not.toHaveProperty("quickReplies");
  });

  it("rejects invalid input before calling dependencies", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const resolveLineSubject = vi.fn();
    const result = await downloadWeeklyPaper(
      { issueNumber: 0 },
      fetchImpl,
      access(resolveLineSubject)
    );
    expect(resolveLineSubject).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ agentResult: { status: "unavailable" } });
  });

  it("enforces a hard HHC request timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        })
    );
    const resultPromise = downloadWeeklyPaper({}, fetchImpl, access());
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(resultPromise).resolves.toMatchObject({ agentResult: { status: "unavailable" } });
  });
});
