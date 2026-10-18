import { describe, expect, it } from "vitest";
import { memberAccessLines, readMemberAccess } from "../account/member-access.js";
import {
  renderAccountIdentity,
  renderCapabilityHelp
} from "../application/capabilities/capability-presenters.js";
import type { EffectiveCapabilityProjection } from "../application/capabilities/effective-capability-projection.js";

const snapshot = {
  qualified: true,
  editions: [{ series: "children", locale: "en" }],
  legal: "required"
};
const reply = (data: unknown) => new Response(JSON.stringify({ data, meta: {}, error: null }));

describe("trusted member access projection", () => {
  it("does not present a granted Bot function as a member content grant", () => {
    const projection: EffectiveCapabilityProjection = {
      reads: [
        {
          functionName: "download_weekly_paper",
          displayName: "下載週報",
          shortDescription: "會員週報",
          example: "下載最新週報",
          quickReply: {
            label: "週報",
            action: { type: "message", label: "週報", text: "下載最新週報" }
          }
        }
      ],
      writes: [],
      onboarding: [],
      accountLoginAvailable: true
    };
    const account = {
      status: "active" as const,
      account: { displayName: "User", maskedEmail: "u***@example.test", roles: ["admin" as const] },
      membership: { qualified: false, editions: [], legal: "not_applicable" as const }
    };
    for (const result of [
      renderAccountIdentity(account, projection),
      renderCapabilityHelp(projection, "help", undefined, account)
    ]) {
      expect(result.replyText).toContain("會員資格：目前未符合");
      expect(result.replyText).not.toContain("下載週報");
    }
    expect(
      renderAccountIdentity({ ...account, membership: "unavailable" }, projection).replyText
    ).toContain("暫時無法確認");
  });
  it("uses only the fresh subject and renders content language independently", async () => {
    const fetchImpl = (async (url, init) => {
      expect(String(url)).toContain("/priv/line/member-access?locale=zh-Hant");
      expect(init?.headers).toMatchObject({
        "X-HHC-User-ID": "fresh-subject",
        "X-HHC-Auth-Provider": "account-api"
      });
      expect(init?.redirect).toBe("error");
      return reply(snapshot);
    }) as typeof fetch;
    const value = await readMemberAccess(fetchImpl, "fresh-subject");
    expect(memberAccessLines(value)).toEqual([
      "會員資格：已符合",
      "週報授權：兒童版・英文",
      "會員條款：待確認最新條款"
    ]);
  });
  it.each([
    { ...snapshot, qualified: "true" },
    { ...snapshot, qualified: false },
    { ...snapshot, legal: "not_applicable" },
    { ...snapshot, editions: [{ series: "children", locale: "zh-Hans" }] },
    { ...snapshot, editions: [snapshot.editions[0], snapshot.editions[0]] },
    { ...snapshot, accountId: "private" }
  ])("rejects inconsistent or overbroad snapshots: %j", async (data) => {
    await expect(
      readMemberAccess((async () => reply(data)) as typeof fetch, "subject")
    ).rejects.toThrow();
  });
  it("distinguishes qualification denial from authority failure", async () => {
    const value = await readMemberAccess(
      (async () =>
        reply({ qualified: false, editions: [], legal: "not_applicable" })) as typeof fetch,
      "subject"
    );
    expect(memberAccessLines(value)[0]).toContain("未符合");
    await expect(
      readMemberAccess((async () => new Response("", { status: 503 })) as typeof fetch, "subject")
    ).rejects.toThrow("member_access_unavailable");
    expect(memberAccessLines("unavailable")[0]).toContain("無法確認");
  });
});
