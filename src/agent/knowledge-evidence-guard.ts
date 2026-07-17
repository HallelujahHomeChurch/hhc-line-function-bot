import { classifySmallTalkCategory } from "../engagement.js";

const WRITE_ACTION = "記住|保存|儲存|存下|新增|修改|更新|刪除|移除|上傳|建立";
const MAX_IMPERATIVE_CONTENT_CHARACTERS = 80;
const BOUNDED_IMPERATIVE_CONTENT = `.{0,${MAX_IMPERATIVE_CONTENT_CHARACTERS}}`;
const POLITE_HELPER = "(?:(?:請|麻煩|可以|可不可以|能不能|能否)(?:你|您)?)?(?:幫我|替我)";
const HELPER_WRITE_PATTERN = new RegExp(
  `^${POLITE_HELPER}(?:把|將)?${BOUNDED_IMPERATIVE_CONTENT}(?:${WRITE_ACTION})`,
  "u"
);
const OBJECT_WRITE_PATTERN = new RegExp(
  `^(?:請)?(?:把|將)${BOUNDED_IMPERATIVE_CONTENT}(?:${WRITE_ACTION})`,
  "u"
);
const DESIRE_WRITE_PATTERN = new RegExp(
  `^(?:我要|要)(?:把|將)?${BOUNDED_IMPERATIVE_CONTENT}(?:${WRITE_ACTION})`,
  "u"
);
const DIRECT_WRITE_PATTERN = new RegExp(`^(?:請)?(?:${WRITE_ACTION})`, "u");
const SHORTHAND_WRITE_PATTERN =
  /^(?:(?:請|麻煩)?(?:你|您)?(?:幫我|替我)?)(?:把|將)?記(?!得|憶|錄)(?:一下)?/u;
const NEGATED_WRITE_PATTERN = new RegExp(
  `(?:不要|不用|不必|先不要|先別|別)${BOUNDED_IMPERATIVE_CONTENT}(?:${WRITE_ACTION}|記(?!得|憶|錄))`,
  "u"
);
const MAX_INTERPERSONAL_QUESTION_CHARACTERS = 48;
const SECOND_PERSON_IDENTITY_QUESTION =
  /^(?:(?:那|那麼|所以|請問|想問|我想問))?(?:你|妳|您)(?:是(?:誰|哪位|(?:什麼|甚麼|啥)(?:樣)?(?:的)?(?:人|角色|身份|身分)?)|叫(?:什麼|甚麼|啥)(?:名字|姓名)?|(?:的)?(?:名字|姓名)(?:叫|是)?(?:什麼|甚麼|啥)|(?:的)?(?:個性|性格|人設)(?:是(?:什麼|甚麼|啥)(?:樣)?|如何|怎麼樣|怎樣)|(?:會|能|可以)(?:做)?(?:什麼|甚麼|啥))(?:啊|呀|呢|嗎|嘛)?$/u;

export function hasWriteIntent(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (NEGATED_WRITE_PATTERN.test(normalized)) return false;
  return (
    HELPER_WRITE_PATTERN.test(normalized) ||
    OBJECT_WRITE_PATTERN.test(normalized) ||
    DESIRE_WRITE_PATTERN.test(normalized) ||
    DIRECT_WRITE_PATTERN.test(normalized) ||
    SHORTHAND_WRITE_PATTERN.test(normalized)
  );
}

export function isConservativeKnowledgeEvidenceText(text: string): boolean {
  const addressedText = stripBotAddress(text);
  if (hasWriteIntent(addressedText)) return false;
  if (isInterpersonalOrSmallTalkText(addressedText)) return false;
  return Array.from(normalizeIntentText(addressedText)).length >= 2;
}

export function isInterpersonalOrSmallTalkText(text: string): boolean {
  const addressedText = stripBotAddress(text);
  if (classifySmallTalkCategory(addressedText)) return true;
  const normalized = normalizeIntentText(addressedText);
  if (Array.from(normalized).length > MAX_INTERPERSONAL_QUESTION_CHARACTERS) return false;
  return SECOND_PERSON_IDENTITY_QUESTION.test(normalized);
}

export function isTaskShapedText(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized || isInterpersonalOrSmallTalkText(text)) return false;
  return /^(?:我想|我要|請|麻煩|可以|可不可以|能不能)?(?:幫我|替我)?(?:查詢|查|找|搜尋|給我|列出|顯示|下載|保存|儲存|記住|上傳)/u.test(
    normalized
  );
}

function stripBotAddress(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/^小哈[\s,，、:：。.!！?？]*/u, "");
}

function normalizeIntentText(text: string): string {
  return stripBotAddress(text)
    .toLocaleLowerCase("zh-TW")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}
