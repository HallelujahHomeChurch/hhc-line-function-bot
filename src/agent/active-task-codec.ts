import { FUNCTION_NAMES, type FunctionName, type JsonRecord } from "../types.js";
import type { ActiveTaskContext } from "./active-task.js";
import type { AgentEntity } from "./result-envelope.js";

const LIMITS = {
  totalBytes: 16_384,
  recordKeys: 16,
  recordKeyChars: 80,
  recordValueChars: 500,
  recordArrayItems: 10,
  recordArrayValueChars: 200,
  evidenceUrlChars: 500,
  entities: 20,
  entityIdChars: 200,
  entityLabelChars: 500,
  aliases: 10,
  aliasChars: 200,
  operations: 8,
  operationChars: 200
} as const;

type NormalizeMode = "sanitize" | "strict";

const ACTIVE_TASK_KEYS = new Set(
  "version currentCapability allowedCapabilities capability anchors entities references supportedOperations responseContext createdAt expiresAt".split(
    " "
  )
);
const ENTITY_KEYS = new Set("type key label aliases".split(" "));
const REFERENCE_KEYS = new Set(
  "id sourceId sourceKey resourceId driveId itemId pageId documentId chunkId memoryId url section sectionKey ordinal".split(
    " "
  )
);
const SENSITIVE_EXACT_KEYS = new Set(
  "key apikey accesskey privatekey secretkey signingkey encryptionkey authorization bearer sharingurl shareurl".split(
    " "
  )
);
const SENSITIVE_KEY_SUFFIXES =
  "token secret password passcode credential credentials apikey accesskey privatekey secretkey signingkey encryptionkey".split(
    " "
  );
const SENSITIVE_CJK_TERMS =
  "密碼 密码 密鑰 密钥 金鑰 金钥 令牌 權杖 权杖 憑證 凭证 口令 秘密".split(" ");
const SHARING_MARKERS = new Set("share sharing temp temporary".split(" "));
const OPAQUE_CREDENTIAL_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u,
  /\bapi[_-]?key[_-][A-Za-z0-9_-]{16,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u
];

export function prepareActiveTaskForStorage(
  task: ActiveTaskContext,
  now: Date
): ActiveTaskContext | undefined {
  return normalizeActiveTask(task, now, "sanitize");
}

export function decodeActiveTask(raw: string, now: Date): ActiveTaskContext | undefined {
  if (serializedBytes(raw) > LIMITS.totalBytes) return undefined;
  try {
    return normalizeActiveTask(JSON.parse(raw) as unknown, now, "strict");
  } catch {
    return undefined;
  }
}

export function cloneActiveTask(task: ActiveTaskContext): ActiveTaskContext {
  return {
    ...task,
    allowedCapabilities: [...task.allowedCapabilities],
    anchors: cloneRecord(task.anchors),
    entities: task.entities.map((entity) => ({
      ...entity,
      ...(entity.aliases ? { aliases: [...entity.aliases] } : {})
    })),
    ...(task.references ? { references: cloneRecord(task.references) } : {}),
    supportedOperations: [...task.supportedOperations],
    ...(task.responseContext
      ? {
          responseContext: {
            availableFields: [...task.responseContext.availableFields],
            defaultProjection: task.responseContext.defaultProjection
          }
        }
      : {})
  };
}

function normalizeActiveTask(
  input: unknown,
  now: Date,
  mode: NormalizeMode
): ActiveTaskContext | undefined {
  if (!isRecord(input) || (mode === "strict" && !hasOnlyKeys(input, ACTIVE_TASK_KEYS))) {
    return undefined;
  }
  if (
    input.version !== 2 ||
    !isFunctionName(input.currentCapability) ||
    input.capability !== input.currentCapability ||
    !isCanonicalTimestamp(input.createdAt) ||
    !isCanonicalTimestamp(input.expiresAt) ||
    Date.parse(input.expiresAt) <= Date.parse(input.createdAt) ||
    Date.parse(input.expiresAt) <= now.getTime()
  ) {
    return undefined;
  }
  const anchors = normalizeAnchors(input.anchors, mode);
  const entities = normalizeEntities(input.entities, mode);
  const references =
    input.references === undefined ? undefined : normalizeReferences(input.references, mode);
  const supportedOperations = normalizeStringArray(
    input.supportedOperations,
    LIMITS.operations,
    LIMITS.operationChars,
    mode
  );
  const allowedCapabilities = normalizeFunctionNames(input.allowedCapabilities);
  const responseContext = normalizeResponseContext(input.responseContext, mode);
  if (
    !anchors ||
    !entities ||
    (input.references !== undefined && !references) ||
    !supportedOperations ||
    !allowedCapabilities ||
    !allowedCapabilities.includes(input.currentCapability) ||
    (input.responseContext !== undefined && !responseContext)
  ) {
    return undefined;
  }
  const task: ActiveTaskContext = {
    version: 2,
    currentCapability: input.currentCapability,
    allowedCapabilities,
    capability: input.currentCapability,
    anchors,
    entities,
    ...(references ? { references } : {}),
    supportedOperations,
    ...(responseContext ? { responseContext } : {}),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  };
  return serializedBytes(task) <= LIMITS.totalBytes ? task : undefined;
}

function normalizeFunctionNames(input: unknown): FunctionName[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > 5) return undefined;
  const names = input.filter((value): value is FunctionName => isFunctionName(value));
  return names.length === input.length ? Array.from(new Set(names)) : undefined;
}

function normalizeResponseContext(
  input: unknown,
  mode: NormalizeMode
): ActiveTaskContext["responseContext"] | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || !hasOnlyKeys(input, new Set(["availableFields", "defaultProjection"]))) {
    return undefined;
  }
  const availableFields = normalizeStringArray(input.availableFields, 20, 80, mode);
  const defaultProjection = input.defaultProjection;
  return availableFields && (defaultProjection === "focused" || defaultProjection === "full")
    ? { availableFields, defaultProjection }
    : undefined;
}

function normalizeAnchors(input: unknown, mode: NormalizeMode): JsonRecord | undefined {
  if (!isRecord(input)) return undefined;
  const entries = Object.entries(input);
  if (
    entries.some(([key, value]) => isForbiddenKey(key) || isUnsafeAnchorValue(value)) ||
    (mode === "strict" && entries.length > LIMITS.recordKeys)
  ) {
    return undefined;
  }
  const output: JsonRecord = {};
  for (const [key, value] of entries.slice(0, LIMITS.recordKeys)) {
    if (characterCount(key) === 0 || characterCount(key) > LIMITS.recordKeyChars) return undefined;
    const normalized = normalizeAnchorValue(value, mode);
    if (normalized === INVALID_VALUE) {
      if (mode === "strict") return undefined;
      continue;
    }
    output[key] = normalized;
  }
  return output;
}

const INVALID_VALUE = Symbol("invalid_active_task_value");

function normalizeAnchorValue(
  value: unknown,
  mode: NormalizeMode
): string | number | boolean | string[] | typeof INVALID_VALUE {
  if (typeof value === "string")
    return normalizeText(value, LIMITS.recordValueChars, mode, true) ?? INVALID_VALUE;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return (
      normalizeStringArray(
        value,
        LIMITS.recordArrayItems,
        LIMITS.recordArrayValueChars,
        mode,
        true
      ) ?? INVALID_VALUE
    );
  }
  return INVALID_VALUE;
}

function isUnsafeAnchorValue(value: unknown): boolean {
  return (
    (typeof value === "string" && isUnsafePlainText(value)) ||
    (Array.isArray(value) &&
      value.some((entry) => typeof entry === "string" && isUnsafePlainText(entry)))
  );
}

function normalizeReferences(input: unknown, mode: NormalizeMode): JsonRecord | undefined {
  if (!isRecord(input)) return undefined;
  const entries = Object.entries(input);
  if (entries.length > LIMITS.recordKeys || entries.some(([key]) => !REFERENCE_KEYS.has(key))) {
    return undefined;
  }
  const output: JsonRecord = {};
  for (const [key, value] of entries) {
    if (key === "ordinal") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
      output[key] = value;
      continue;
    }
    const normalized =
      key === "url"
        ? normalizeEvidenceUrl(value)
        : normalizeText(value, LIMITS.recordValueChars, mode);
    if (!normalized) return undefined;
    output[key] = normalized;
  }
  return output;
}

function normalizeEntities(input: unknown, mode: NormalizeMode): AgentEntity[] | undefined {
  if (!Array.isArray(input) || (mode === "strict" && input.length > LIMITS.entities)) {
    return undefined;
  }
  const output: AgentEntity[] = [];
  for (const value of input.slice(0, LIMITS.entities)) {
    if (!isRecord(value) || (mode === "strict" && !hasOnlyKeys(value, ENTITY_KEYS))) {
      return undefined;
    }
    const type = normalizeText(value.type, LIMITS.entityIdChars, mode);
    const key = normalizeText(value.key, LIMITS.entityIdChars, mode);
    const label = normalizeText(value.label, LIMITS.entityLabelChars, mode);
    const aliases =
      value.aliases === undefined
        ? undefined
        : normalizeStringArray(value.aliases, LIMITS.aliases, LIMITS.aliasChars, mode);
    if (!type || !key || !label || (value.aliases !== undefined && !aliases)) return undefined;
    output.push({ type, key, label, ...(aliases ? { aliases } : {}) });
  }
  return output;
}

function normalizeStringArray(
  input: unknown,
  maxItems: number,
  maxChars: number,
  mode: NormalizeMode,
  allowEmpty = false
): string[] | undefined {
  if (
    !Array.isArray(input) ||
    !input.every((value) => typeof value === "string") ||
    (mode === "strict" && input.length > maxItems) ||
    input.some((value) => isUnsafePlainText(value))
  ) {
    return undefined;
  }
  const output = input
    .slice(0, maxItems)
    .map((value) => normalizeText(value, maxChars, mode, allowEmpty));
  return output.some((value) => value === undefined) ? undefined : (output as string[]);
}

function normalizeText(
  value: unknown,
  maxChars: number,
  mode: NormalizeMode,
  allowEmpty = false
): string | undefined {
  if (
    typeof value !== "string" ||
    (!allowEmpty && characterCount(value) === 0) ||
    isUnsafePlainText(value) ||
    (mode === "strict" && characterCount(value) > maxChars)
  ) {
    return undefined;
  }
  return truncateText(value, maxChars);
}

function normalizeEvidenceUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    characterCount(value) === 0 ||
    characterCount(value) > LIMITS.evidenceUrlChars ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  // Active-task URLs are stable public locators only. Persist provider-specific
  // evidence through the allowlisted stable ID fields, never signed/share URLs.
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isUnsafeLocator(url)
  ) {
    return undefined;
  }
  return value;
}

function isUnsafeLocator(url: URL): boolean {
  const hostname = decodePercentEncoding(url.hostname).toLowerCase();
  const pathname = decodePercentEncoding(url.pathname).toLowerCase();
  const pathSegments = pathname.split("/").filter(Boolean);
  return (
    hasControlCharacter(hostname) ||
    hasControlCharacter(pathname) ||
    /(?:https?|line):\/\//iu.test(hostname) ||
    /(?:https?|line):\/\//iu.test(pathname) ||
    hostname === "1drv.ms" ||
    (hostname.endsWith(".sharepoint.com") && pathname.startsWith("/:")) ||
    pathSegments.some((segment) => SHARING_MARKERS.has(segment))
  );
}

function isUnsafePlainText(value: string): boolean {
  return (
    /\b(?:https?|line):\/\/\S+/iu.test(value) ||
    /\bwww\.[^\s]+/iu.test(value) ||
    hasOpaqueCredential(value)
  );
}

function hasOpaqueCredential(value: string): boolean {
  return (
    /\bbearer\s+\S+/iu.test(value) ||
    /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|secret|password)\s*[:=]\s*\S+/iu.test(
      value
    ) ||
    OPAQUE_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function isForbiddenKey(value: string): boolean {
  return (
    ["proto", "prototype", "constructor"].includes(normalizeKey(value)) || isSensitiveKey(value)
  );
}

function isSensitiveKey(value: string): boolean {
  const normalized = normalizeKey(value);
  return (
    SENSITIVE_EXACT_KEYS.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    SENSITIVE_CJK_TERMS.some((term) => normalized.includes(term))
  );
}

function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function isFunctionName(value: unknown): value is FunctionName {
  return typeof value === "string" && (FUNCTION_NAMES as readonly string[]).includes(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function cloneRecord(input: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
  );
}

function decodePercentEncoding(value: string): string {
  let decoded = value;
  for (let round = 0; round < 3; round += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function truncateText(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function serializedBytes(value: unknown): number {
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return new TextEncoder().encode(serialized).length;
}
