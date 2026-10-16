import type { JsonRecord } from "../types.js";

export function matchesWeeklyPaper(text: string): boolean {
  return (
    !/(?:不要|不用|取消)/u.test(text) &&
    /(?:下載|查看|閱讀|最新|第\s*\d+\s*期).*週報|週報.*(?:下載|查看|閱讀|最新|第\s*\d+\s*期)/u.test(
      text.normalize("NFKC")
    )
  );
}

export function weeklyPaperArguments(text: string): JsonRecord {
  const normalized = text.normalize("NFKC");
  if (!/(?:週報|weekly\s+paper)/iu.test(normalized)) return {};
  const rawIssueNumber =
    normalized.match(/(?:第\s*)?(?<![\d.+-])(\d+)(?![\d.])\s*期/u)?.[1] ??
    normalized.match(/(?<![\d.+-])(\d+)(?![\d.])\s*週報/u)?.[1];
  const series = /兒童|儿童/u.test(normalized)
    ? "children"
    : /一般/u.test(normalized)
      ? "general"
      : undefined;
  const locale = /英文|英語|English/iu.test(normalized)
    ? "en"
    : /簡體|简体|簡中|简中/u.test(normalized)
      ? "zh-Hans"
      : /繁體|繁体|繁中/u.test(normalized)
        ? "zh-Hant"
        : undefined;
  return {
    ...(rawIssueNumber ? { issueNumber: Number(rawIssueNumber) } : {}),
    ...(series ? { series } : {}),
    ...(locale ? { locale } : {})
  };
}
