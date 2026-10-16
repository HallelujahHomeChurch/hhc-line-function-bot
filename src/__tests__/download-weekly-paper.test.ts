import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWeeklyPaper } from "../capabilities/download-weekly-paper.js";
import { weeklyPaperArguments } from "../capabilities/weekly-paper-request.js";
import type { MemberAccessSnapshot } from "../account/member-access.js";

const lineUserId = `U${"a".repeat(32)}`;
const subjectId = "018f0c1f-18d0-7e81-9f6f-69c456db7003";
const grant: MemberAccessSnapshot = {
  qualified: true,
  editions: [{ series: "general", locale: "zh-Hant" }],
  legal: "allowed"
};
const item = {
  issueNumber: 1733,
  series: "general",
  contentLocale: "zh-Hant",
  pdfPublished: true,
  onlineRevision: 2
};
const envelope = (data: unknown) => Response.json({ data, meta: {}, error: null });
function access(
  resolveLineSubject = vi.fn().mockResolvedValue({ bound: true, active: true, subjectId })
) {
  return { lineUserId, profileName: "main", requestId: "request-1", resolveLineSubject };
}
function upstream(data: unknown = { items: [item] }, membership: MemberAccessSnapshot = grant) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      String(url).includes("/priv/line/member-access")
        ? envelope(membership)
        : data instanceof Response
          ? data
          : envelope(data)
    );
}
afterEach(() => vi.useRealTimers());

describe("member bulletin entry", () => {
  it("checks fresh membership and discovers the exact authorized issue", async () => {
    const fetchImpl = upstream();
    const member = access();
    const result = await downloadWeeklyPaper({ issueNumber: 1733 }, fetchImpl, member);
    expect(member.resolveLineSubject).toHaveBeenCalledWith({ lineUserId, profileName: "main" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toContain(
      "/api/member/bulletins/online?series=general&locales=zh-Hant&offset=0&limit=1&issueNumber=1733"
    );
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        "X-HHC-User-ID": subjectId,
        "X-HHC-Auth-Provider": "account-api",
        "X-HHC-Request-ID": "request-1"
      }
    });
    expect(result.agentResult?.status).toBe("success");
    expect(result.quickReplies?.[0]?.action).toMatchObject({
      type: "uri",
      uri: "https://www.alive.org.tw/zh-Hant/literature-ministry?series=general&issueNumber=1733&contentLocale=zh-Hant&mode=online"
    });
  });
  it("offers every authorized edition without guessing content language", async () => {
    const membership: MemberAccessSnapshot = {
      ...grant,
      editions: [...grant.editions, { series: "children", locale: "en" }]
    };
    const fetchImpl = upstream(undefined, membership);
    const result = await downloadWeeklyPaper({ issueNumber: 1733 }, fetchImpl, access());
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.agentResult?.status).toBe("ambiguous");
    expect(result.quickReplies).toHaveLength(2);
    const action = result.quickReplies![1]!.action;
    if (action.type !== "message") throw new Error("missing edition choice");
    expect(weeklyPaperArguments(action.text)).toEqual({
      issueNumber: 1733,
      series: "children",
      locale: "en"
    });
  });
  it("supports children English without a PDF under a Traditional Chinese interface", async () => {
    const fetchImpl = upstream(
      { items: [{ ...item, series: "children", contentLocale: "en", pdfPublished: false }] },
      { ...grant, editions: [{ series: "children", locale: "en" }] }
    );
    const result = await downloadWeeklyPaper(
      { series: "children", locale: "en" },
      fetchImpl,
      access()
    );
    expect(result.quickReplies?.[0]?.action).toMatchObject({
      uri: expect.stringContaining("series=children&issueNumber=1733&contentLocale=en&mode=online")
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).not.toContain("issueNumber=");
  });
  it("links PDF-only issues to the exact PDF entry", async () => {
    const result = await downloadWeeklyPaper(
      {},
      upstream({ items: [{ ...item, onlineRevision: null }] }),
      access()
    );
    expect(result.quickReplies?.[0]?.action).toMatchObject({
      uri: expect.stringContaining("issueNumber=1733&contentLocale=zh-Hant&mode=pdf")
    });
  });
  it("does not substitute an explicitly ungranted edition", async () => {
    const fetchImpl = upstream();
    const result = await downloadWeeklyPaper(
      { series: "children", locale: "en" },
      fetchImpl,
      access()
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.agentResult?.status).toBe("unavailable");
    expect(result.replyText).toContain("存取資格");
  });
  it.each([
    { bound: false, active: false },
    { bound: true, active: false }
  ])("stops before member APIs for %j", async (decision) => {
    const fetchImpl = upstream();
    expect(
      (await downloadWeeklyPaper({}, fetchImpl, access(vi.fn().mockResolvedValue(decision))))
        .agentResult?.status
    ).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("fails closed on Account or membership authority outage", async () => {
    const fetchImpl = upstream();
    await downloadWeeklyPaper(
      {},
      fetchImpl,
      access(vi.fn().mockRejectedValue(new Error("offline")))
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      (await downloadWeeklyPaper({}, async () => new Response("", { status: 503 }), access()))
        .quickReplies
    ).toBeUndefined();
  });
  it.each([undefined, 1733])(
    "preserves legal return edition and requested issue %s",
    async (issueNumber) => {
      const fetchImpl = upstream(undefined, { ...grant, legal: "required" });
      const result = await downloadWeeklyPaper(
        { ...(issueNumber ? { issueNumber } : {}) },
        fetchImpl,
        access()
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
      const action = result.quickReplies?.[0]?.action;
      if (action?.type !== "uri") throw new Error("missing legal action");
      const target = new URL(new URL(action.uri).searchParams.get("return_to")!);
      expect(target.searchParams.get("contentLocale")).toBe("zh-Hant");
      expect(target.searchParams.get("issueNumber")).toBe(issueNumber ? String(issueNumber) : null);
    }
  );
  it.each([
    [403, "access_required"],
    [428, "policy_acceptance_required"]
  ] as const)("retains an actionable fresh content denial %s", async (status, code) => {
    const result = await downloadWeeklyPaper(
      { issueNumber: 1733 },
      upstream(Response.json({ error: { code } }, { status })),
      access()
    );
    expect(result.quickReplies?.[0]?.action.type).toBe("uri");
  });
  it.each([
    new Response("", { status: 503 }),
    new Response("invalid"),
    Response.json({ error: { code: "forbidden_workload" } }, { status: 403 })
  ])("does not mislabel malformed or workload errors", async (response) => {
    const result = await downloadWeeklyPaper({}, upstream(response), access());
    expect(result.agentResult?.status).toBe("unavailable");
    expect(result.quickReplies).toBeUndefined();
  });
  it.each([
    { items: [] },
    { items: [{ ...item, onlineRevision: null, pdfPublished: false }] },
    new Response("", { status: 404 })
  ])("does not disclose an unavailable issue", async (data) => {
    expect(
      (await downloadWeeklyPaper({ issueNumber: 1733 }, upstream(data), access())).agentResult
        ?.status
    ).toBe("not_found");
  });
  it.each([
    { items: [{ ...item, issueNumber: 1732 }] },
    { items: [{ ...item, contentLocale: "en" }] },
    { items: [{ ...item, series: "children" }] },
    { items: [item, item] },
    { items: [{ ...item, onlineRevision: "2" }] },
    [item]
  ])("rejects mismatched discovery contracts", async (data) => {
    expect(
      (await downloadWeeklyPaper({ issueNumber: 1733 }, upstream(data), access())).agentResult
        ?.status
    ).toBe("unavailable");
  });
  it("rejects invalid input before dependencies", async () => {
    const member = access();
    const fetchImpl = upstream();
    await downloadWeeklyPaper({ issueNumber: 0 }, fetchImpl, member);
    expect(member.resolveLineSubject).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("aborts a stalled discovery request", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((url, init) =>
      String(url).includes("/priv/line/member-access")
        ? Promise.resolve(envelope(grant))
        : new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            })
          )
    );
    const result = downloadWeeklyPaper({}, fetchImpl, access());
    await vi.advanceTimersByTimeAsync(3001);
    expect((await result).agentResult?.status).toBe("unavailable");
  });
});
