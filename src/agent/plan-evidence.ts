import type { AgentActiveEvidenceRule, AgentCapabilityContract } from "../functions/definitions.js";
import type { JsonRecord } from "../types.js";
import type { ActiveTaskContext } from "./active-task.js";
import type { AgentEntity } from "./result-envelope.js";
import { isInterpersonalOrSmallTalkText } from "./knowledge-evidence-guard.js";

export interface GroundPlanRecordInput {
  record: Record<string, unknown>;
  text: string;
  rules?: Record<string, AgentActiveEvidenceRule>;
  activeTask?: ActiveTaskContext;
  activeAuthority: boolean;
}

export interface GroundedPlanRecord {
  value: JsonRecord;
  ambiguous: boolean;
}

const RELATIVE_VALUE_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  today: ["今天", "今日"],
  tomorrow: ["明天", "明日"],
  day_after_tomorrow: ["後天"],
  this_week: ["本週", "這週", "本周", "這周"],
  next_meeting: ["下一場", "下場", "下一次", "下次", "最近一場"],
  upcoming: ["近期", "接下來"],
  morning_prayer_family: ["晨更", "晨更家族"],
  street_sign_service: ["舉牌", "為耶穌舉牌"],
  custom_service_schedule: ["自訂服事", "其他服事"],
  ppt_slide: ["投影片", "簡報", "ppt"],
  sheet_music: ["歌譜", "樂譜"],
  private: ["私人", "自己"],
  group: ["群組", "大家", "共用"]
};

const AFFIRMATIVE_TERMS = ["確認", "確定", "同意", "可以"];
const EXPLICIT_NEGATIVE_PATTERN =
  /(?:不要|不用|不必|先不要|先別|別|取消|否|拒絕|不確認|不確定|不同意|不可以)/u;
const AFFIRMATIVE_NEGATION_PREFIX = /(?:不要|不用|不必|先不要|先別|別|不)$/u;
const ACTIVE_TASK_REPLAY_PATTERN =
  /(?:再給我一次|再給一次|再傳一次|再貼一次|剛剛那份|剛才那份|剛剛那個|上一份)/u;

export function groundPlanRecord(input: GroundPlanRecordInput): GroundedPlanRecord {
  const output: JsonRecord = {};
  for (const [key, proposedValue] of Object.entries(input.record)) {
    const grounded = groundValue(key, proposedValue, input);
    if (grounded.ambiguous) return { value: {}, ambiguous: true };
    if (grounded.value !== undefined) output[key] = grounded.value;
  }
  return { value: output, ambiguous: false };
}

export function hasCurrentTextEvidence(text: string, value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => hasCurrentTextEvidence(text, entry));
  }
  if (typeof value === "boolean") {
    return value
      ? hasUnnegatedAffirmative(text)
      : EXPLICIT_NEGATIVE_PATTERN.test(normalizeText(text));
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && numericTokenPattern(String(value)).test(normalizeText(text));
  }
  if (typeof value !== "string" || !value.trim()) return false;

  const normalizedValue = value.normalize("NFKC").trim().toLocaleLowerCase("zh-TW");
  const date = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (
    date &&
    fullDatePattern(Number(date[1]), Number(date[2]), Number(date[3])).test(normalizeText(text))
  ) {
    return true;
  }
  const relativeTerms = RELATIVE_VALUE_EVIDENCE[normalizedValue] ?? [];
  if (relativeTerms.some((term) => containsNormalizedPhrase(text, term))) return true;
  if (/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(normalizedValue)) {
    return asciiTokenPattern(normalizedValue).test(
      text.normalize("NFKC").toLocaleLowerCase("zh-TW")
    );
  }
  return containsNormalizedPhrase(text, normalizedValue);
}

export function hasActiveEntityTextEvidence(
  text: string,
  contract: AgentCapabilityContract,
  activeTask: ActiveTaskContext
): boolean {
  const declaredTypes = new Set(
    Object.values(contract.activeEvidence?.arguments ?? {}).flatMap(
      ({ entityTypes }) => entityTypes ?? []
    )
  );
  return (
    activeTask.entities.some(
      (entity) => declaredTypes.has(entity.type) && entityHasTextEvidence(text, entity)
    ) ||
    hasEllipticalActiveTaskReference(text) ||
    hasDeclaredResponseFieldEvidence(text, contract, activeTask)
  );
}

function hasDeclaredResponseFieldEvidence(
  text: string,
  contract: AgentCapabilityContract,
  activeTask: ActiveTaskContext
): boolean {
  if (isInterpersonalOrSmallTalkText(text)) return false;
  const normalized = normalizeComparable(text);
  if (!normalized || Array.from(normalized).length > 40) return false;
  if (
    activeTask.supportedOperations.includes("continue") &&
    ACTIVE_TASK_REPLAY_PATTERN.test(normalized)
  ) {
    return true;
  }
  if (
    activeTask.supportedOperations.includes("view_full") &&
    /(?:完整|全部|整份|全文|查看全文)/u.test(normalized)
  ) {
    return true;
  }
  const available = new Set(activeTask.responseContext?.availableFields ?? []);
  return Object.entries(contract.responseProjection?.fields ?? {}).some(([key, field]) => {
    if (available.size > 0 && !available.has(key)) return false;
    return [key, field.label, ...field.aliases].some((value) => {
      const candidate = normalizeComparable(value);
      return candidate.length > 0 && normalized.includes(candidate);
    });
  });
}

export function hasEllipticalActiveTaskReference(text: string): boolean {
  if (isInterpersonalOrSmallTalkText(text)) return false;
  const normalized = normalizeComparable(text);
  return (
    /^(?:那|這|其中|剛剛|剛才)/u.test(normalized) &&
    /(?:誰|哪裡|哪邊|哪個|何時|幾點|幾時|什麼時候|什麼|怎麼|如何|多久|多少|時間|地點|集合)/u.test(
      normalized
    )
  );
}

export function liveActiveTask(
  activeTask: ActiveTaskContext | undefined,
  now: Date
): ActiveTaskContext | undefined {
  if (!activeTask) return undefined;
  const createdAt = Date.parse(activeTask.createdAt);
  const expiresAt = Date.parse(activeTask.expiresAt);
  return Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > createdAt &&
    createdAt <= now.getTime() &&
    expiresAt > now.getTime()
    ? activeTask
    : undefined;
}

function groundValue(
  key: string,
  value: unknown,
  input: GroundPlanRecordInput
): { value?: unknown; ambiguous: boolean } {
  if (Array.isArray(value)) {
    if (value.length === 0) return { ambiguous: false };
    const grounded = value.map((entry) => groundValue(key, entry, input));
    if (grounded.some(({ ambiguous }) => ambiguous)) return { ambiguous: true };
    if (grounded.some(({ value: item }) => item === undefined)) return { ambiguous: false };
    return { value: grounded.map(({ value: item }) => item), ambiguous: false };
  }
  if (!isScalar(value)) return { ambiguous: false };

  const rule = input.rules?.[key];
  if (input.activeAuthority && input.activeTask && rule) {
    const entityMatches = matchingRuleEntities(input.text, rule, input.activeTask);
    if (entityMatches.length > 1) return { ambiguous: true };
    if (entityMatches.length === 1) {
      return entityMatchesValue(entityMatches[0], value)
        ? { value, ambiguous: false }
        : { ambiguous: false };
    }
    if (groundFromDeclaredStorage(value, rule, input.activeTask)) {
      return { value, ambiguous: false };
    }
    if (matchesAnyTaskEntity(input.text, input.activeTask)) return { ambiguous: false };
  }

  if (
    hasNormalizedArgumentEvidence(key, input.text, value) ||
    hasCurrentTextEvidence(input.text, value)
  ) {
    return { value, ambiguous: false };
  }
  return { ambiguous: false };
}

function hasNormalizedArgumentEvidence(
  key: string,
  text: string,
  value: string | number | boolean
): boolean {
  if (key !== "ordinal" || typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return false;
  }
  const normalized = text.normalize("NFKC");
  const digit = normalized.match(/第\s*(\d+)\s*(?:個|項|站|天|步|地點)/u)?.[1];
  if (digit) return Number(digit) - 1 === value;
  const chinese: Array<[RegExp, number]> = [
    [/第?一(?:個|項|站|天|步|地點)/u, 0],
    [/第?二(?:個|項|站|天|步|地點)/u, 1],
    [/第?三(?:個|項|站|天|步|地點)/u, 2]
  ];
  return chinese.some(([pattern, ordinal]) => ordinal === value && pattern.test(normalized));
}

function matchingRuleEntities(
  text: string,
  rule: AgentActiveEvidenceRule,
  activeTask: ActiveTaskContext
): AgentEntity[] {
  const allowedTypes = new Set(rule.entityTypes ?? []);
  const matches = activeTask.entities
    .filter((entity) => allowedTypes.has(entity.type))
    .map((entity) => ({ entity, score: entityEvidenceScore(text, entity) }))
    .filter(({ score }) => score > 0);
  const strongest = Math.max(0, ...matches.map(({ score }) => score));
  return matches.filter(({ score }) => score === strongest).map(({ entity }) => entity);
}

function entityEvidenceScore(text: string, entity: AgentEntity): number {
  return Math.max(
    0,
    ...[entity.key, entity.label, ...(entity.aliases ?? [])].map((term) =>
      hasCurrentTextEvidence(text, term) ? Array.from(normalizeComparable(term)).length : 0
    )
  );
}

function groundFromDeclaredStorage(
  value: string | number | boolean,
  rule: AgentActiveEvidenceRule,
  activeTask: ActiveTaskContext
): boolean {
  return (
    (rule.anchorKeys ?? []).some((key) => valuesEqual(activeTask.anchors[key], value)) ||
    (rule.referenceKeys ?? []).some((key) => valuesEqual(activeTask.references?.[key], value))
  );
}

function matchesAnyTaskEntity(text: string, activeTask: ActiveTaskContext): boolean {
  return activeTask.entities.some((entity) => entityHasTextEvidence(text, entity));
}

function entityHasTextEvidence(text: string, entity: AgentEntity): boolean {
  return [entity.key, entity.label, ...(entity.aliases ?? [])].some((term) =>
    hasCurrentTextEvidence(text, term)
  );
}

function entityContainsValue(entity: AgentEntity, value: unknown): boolean {
  if (typeof value !== "string") return false;
  return [entity.key, entity.label, ...(entity.aliases ?? [])].some(
    (term) => normalizeComparable(term) === normalizeComparable(value)
  );
}

function entityMatchesValue(entity: AgentEntity, value: string | number | boolean): boolean {
  return (
    entityContainsValue(entity, value) ||
    [entity.key, entity.label, ...(entity.aliases ?? [])].some((term) =>
      hasCurrentTextEvidence(term, value)
    )
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  return isScalar(left) && isScalar(right)
    ? normalizeComparable(String(left)) === normalizeComparable(String(right))
    : false;
}

function hasUnnegatedAffirmative(text: string): boolean {
  const normalized = normalizeText(text);
  return AFFIRMATIVE_TERMS.some((term) => {
    let start = normalized.indexOf(term);
    while (start >= 0) {
      const prefix = normalized.slice(Math.max(0, start - 4), start);
      if (!AFFIRMATIVE_NEGATION_PREFIX.test(prefix)) return true;
      start = normalized.indexOf(term, start + term.length);
    }
    return false;
  });
}

function containsNormalizedPhrase(text: string, phrase: string): boolean {
  const normalizedPhrase = normalizeComparable(phrase);
  return normalizedPhrase.length > 0 && normalizeComparable(text).includes(normalizedPhrase);
}

function asciiTokenPattern(value: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(value)}(?:$|[^a-z0-9])`, "u");
}

function numericTokenPattern(value: string): RegExp {
  return new RegExp(`(?:^|[^0-9])${escapeRegExp(value)}(?:$|[^0-9])`, "u");
}

function fullDatePattern(year: number, month: number, day: number): RegExp {
  return new RegExp(
    `(?:^|[^0-9])${year}(?:[-/]0?${month}[-/]0?${day}|年0?${month}月0?${day}日)(?:$|[^0-9])`,
    "u"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-TW");
}

function normalizeComparable(value: string): string {
  return normalizeText(value).replace(/[\p{P}\p{S}\s]+/gu, "");
}
