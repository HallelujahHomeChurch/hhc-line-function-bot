import type { ScheduleDomainConfig } from "../types.js";
import type { ResolutionCandidate, ResolutionDecision } from "../agent/resolution.js";
import { decideResolution } from "../agent/resolution.js";

export const DEFAULT_SCHEDULE_DOMAINS: ScheduleDomainConfig[] = [
  domain({
    key: "media_team_service",
    displayName: "影視團隊服事",
    aliases: ["影視團隊", "影音團隊", "媒體團隊", "影視"],
    routingHints: [
      "音控",
      "導播",
      "直播",
      "投影電腦",
      "前攝影",
      "後攝影",
      "手機拍照",
      "機動",
      "單眼相機",
      "音效電腦",
      "計時"
    ],
    inputSchema: "assignment_rows_v1",
    binding: {
      kind: "canonical",
      sourceKeys: ["media_team_service_schedule"],
      allowLiveFallback: true
    },
    origins: ["notion"],
    writePolicy: { mode: "read_only", allowedOperations: [] },
    priority: 100
  }),
  domain({
    key: "morning_prayer_family",
    displayName: "晨更家族服事",
    aliases: ["晨更家族", "家族晨更", "晨更", "仙履奇緣"],
    routingHints: ["帶領家族", "服事家族", "家園"],
    inputSchema: "family_rotation_v1",
    binding: { kind: "saved_schedule", scheduleType: "morning_prayer_family" },
    origins: ["line"],
    writePolicy: { mode: "replace_add", allowedOperations: ["replace", "add_entry"] },
    priority: 90
  }),
  domain({
    key: "street_sign_service",
    displayName: "為耶穌舉牌服事",
    aliases: ["為耶穌舉牌", "舉牌服事", "舉牌"],
    routingHints: ["舉牌家族"],
    inputSchema: "family_rotation_v1",
    binding: { kind: "saved_schedule", scheduleType: "street_sign_service" },
    origins: ["line"],
    writePolicy: { mode: "replace_add", allowedOperations: ["replace", "add_entry"] },
    priority: 80
  }),
  domain({
    key: "children_sunday",
    displayName: "兒童主日服事",
    aliases: ["兒童主日", "兒主服事"],
    routingHints: ["兒主"],
    inputSchema: "assignment_rows_v1",
    binding: { kind: "saved_schedule", scheduleType: "children_sunday" },
    origins: ["line"],
    writePolicy: { mode: "replace_add", allowedOperations: ["replace", "add_entry"] },
    priority: 70
  }),
  domain({
    key: "prayer_meeting_family",
    displayName: "禱告會家族服事",
    aliases: ["禱告會服事家族", "禱告會家族", "禱告會服事"],
    routingHints: ["禱告會帶領"],
    inputSchema: "family_rotation_v1",
    binding: { kind: "saved_schedule", scheduleType: "prayer_meeting_family" },
    origins: ["line"],
    writePolicy: { mode: "replace_add", allowedOperations: ["replace", "add_entry"] },
    priority: 60
  }),
  domain({
    key: "custom_service_schedule",
    displayName: "其他服事",
    aliases: ["自訂服事", "其他服事"],
    routingHints: [],
    inputSchema: "assignment_rows_v1",
    binding: { kind: "saved_schedule", scheduleType: "custom_service_schedule" },
    origins: ["line"],
    writePolicy: { mode: "replace_add", allowedOperations: ["replace", "add_entry"] },
    priority: 10
  })
];

function domain(
  input: Omit<
    ScheduleDomainConfig,
    "schemaVersion" | "occurrencePolicy" | "revision" | "freshnessPolicy"
  >
): ScheduleDomainConfig {
  return {
    ...input,
    schemaVersion: 1,
    occurrencePolicy: "profile_meeting_windows_v1",
    revision: "1",
    freshnessPolicy: { maxAgeSeconds: 86_400, staleBehavior: "reject" }
  };
}

export function scheduleDomainCandidate(domain: ScheduleDomainConfig): ResolutionCandidate {
  return {
    id: `schedule:${domain.key}`,
    capability: "query_schedule",
    domainKey: domain.key,
    displayName: domain.displayName,
    evidenceKinds: ["domain_alias"],
    requiredSlots: [],
    reference:
      domain.binding.kind === "canonical"
        ? { sourceKeys: domain.binding.sourceKeys }
        : { scheduleType: domain.binding.scheduleType }
  };
}

export function resolveScheduleDomain(input: {
  domains: ScheduleDomainConfig[];
  text: string;
  requestedDomainKey?: string;
  activeDomainKey?: string;
  availableDomainKeys?: string[];
}): ResolutionDecision {
  const eligible = new Set(input.availableDomainKeys ?? input.domains.map(({ key }) => key));
  const byKey = (key: string) =>
    input.domains.find((item) => item.key === key && eligible.has(key));
  const fixed = input.requestedDomainKey || input.activeDomainKey;
  if (fixed) {
    const selected = byKey(fixed);
    return decideResolution(selected ? [scheduleDomainCandidate(selected)] : []);
  }

  const normalized = normalize(input.text);
  if (!normalized) return { status: "not_found" };
  const matches = input.domains
    .filter(({ key }) => eligible.has(key))
    .map((domain) => ({
      domain,
      aliases: domain.aliases.map(normalize).filter((term) => term && normalized.includes(term)),
      hints: domain.routingHints.map(normalize).filter((term) => term && normalized.includes(term))
    }))
    .filter(({ aliases, hints }) => aliases.length > 0 || hints.length > 0)
    .filter(
      ({ aliases }, _index, all) =>
        aliases.length === 0 ||
        !aliases.every((term) =>
          all.some(
            (other) =>
              other.aliases !== aliases &&
              other.aliases.some(
                (otherTerm) => otherTerm.length > term.length && otherTerm.includes(term)
              )
          )
        )
    )
    .map(({ domain }) => domain)
    .sort((left, right) => right.priority - left.priority || left.key.localeCompare(right.key))
    .map(scheduleDomainCandidate);
  return decideResolution(matches);
}

export function scheduleDomainChoices(domains: ScheduleDomainConfig[]): ResolutionCandidate[] {
  return [...domains]
    .sort((left, right) => right.priority - left.priority || left.key.localeCompare(right.key))
    .map(scheduleDomainCandidate);
}

export function findScheduleDomain(
  domains: ScheduleDomainConfig[],
  domainKey?: string
): ScheduleDomainConfig | undefined {
  return domainKey ? domains.find(({ key }) => key === domainKey) : undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-TW").replace(/\s+/gu, "");
}
