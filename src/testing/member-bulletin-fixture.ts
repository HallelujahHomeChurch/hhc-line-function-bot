export function memberBulletinFixture(input: Parameters<typeof fetch>[0]): Response {
  const path = new URL(String(input)).pathname;
  const data = path.endsWith("/priv/line/member-access")
    ? { qualified: true, editions: [{ series: "general", locale: "zh-Hant" }], legal: "allowed" }
    : path.endsWith("/api/member/bulletins/online")
      ? {
          items: [
            {
              issueNumber: 1733,
              series: "general",
              contentLocale: "zh-Hant",
              pdfPublished: true,
              onlineRevision: 2
            }
          ],
          total: 1,
          offset: 0,
          limit: 1
        }
      : undefined;
  if (!data) throw new Error(`unexpected_member_fixture_path:${path}`);
  return Response.json({ data, meta: {}, error: null });
}
