import { z } from "zod";

export const bulletinEditionSchema = z
  .object({
    series: z.enum(["general", "children"]),
    locale: z.enum(["zh-Hant", "zh-Hans", "en"])
  })
  .strict()
  .refine((edition) => edition.series !== "children" || edition.locale !== "zh-Hans");
export type BulletinEdition = z.infer<typeof bulletinEditionSchema>;

const memberAccessSchema = z
  .object({
    qualified: z.boolean(),
    editions: z.array(bulletinEditionSchema).max(5),
    legal: z.enum(["allowed", "required", "not_applicable"])
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.editions.map(({ series, locale }) => `${series}/${locale}`)).size ===
        value.editions.length &&
      (value.qualified
        ? value.legal !== "not_applicable"
        : value.legal === "not_applicable" && value.editions.length === 0)
  );
export type MemberAccessSnapshot = z.infer<typeof memberAccessSchema>;
export type MemberAccessPresentation = MemberAccessSnapshot | "unavailable";

export async function readMemberAccess(
  fetchImpl: typeof fetch,
  subjectId: string,
  requestId?: string
): Promise<MemberAccessSnapshot> {
  const response = await fetchImpl(
    "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method/priv/line/member-access?locale=zh-Hant",
    {
      headers: {
        "X-HHC-User-ID": subjectId,
        "X-HHC-Auth-Provider": "account-api",
        ...(requestId ? { "X-HHC-Request-ID": requestId } : {})
      },
      redirect: "error",
      signal: AbortSignal.timeout(3_000)
    }
  );
  if (!response.ok) throw new Error("member_access_unavailable");
  const envelope = z
    .object({ data: memberAccessSchema, error: z.null(), meta: z.object({}).passthrough() })
    .parse(await response.json());
  return envelope.data;
}

export function editionLabel(edition: BulletinEdition): string {
  const series = edition.series === "children" ? "兒童版" : "一般版";
  const language = { "zh-Hant": "繁體中文", "zh-Hans": "簡體中文", en: "英文" }[edition.locale];
  return `${series}・${language}`;
}

export function memberAccessLines(access: MemberAccessPresentation | undefined): string[] {
  if (!access) return [];
  if (access === "unavailable") return ["會員狀態：暫時無法確認，請稍後再試。"];
  if (!access.qualified) return ["會員資格：目前未符合，請至會員頁面確認或聯絡管理同工。"];
  return [
    "會員資格：已符合",
    access.editions.length
      ? `週報授權：${access.editions.map(editionLabel).join("、")}`
      : "週報授權：尚未開通",
    access.legal === "required" ? "會員條款：待確認最新條款" : "會員條款：已完成"
  ];
}
