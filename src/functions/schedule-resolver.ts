import {
  decideResolution,
  type ResolutionCandidate,
  type ResolutionDecision
} from "../agent/resolution.js";

export const SCHEDULE_DOMAIN_KEYS = {
  media: "media_team_service",
  family: "morning_prayer_family"
} as const;

const candidates: Record<keyof typeof SCHEDULE_DOMAIN_KEYS, ResolutionCandidate> = {
  media: {
    id: "schedule:media_team_service",
    capability: "query_schedule",
    domainKey: SCHEDULE_DOMAIN_KEYS.media,
    displayName: "影視團隊服事",
    evidenceKinds: ["role", "team"],
    requiredSlots: [],
    reference: { sourceKeys: ["media_team_service_schedule"] }
  },
  family: {
    id: "schedule:morning_prayer_family",
    capability: "query_schedule",
    domainKey: SCHEDULE_DOMAIN_KEYS.family,
    displayName: "晨更家族服事",
    evidenceKinds: ["participant", "family"],
    requiredSlots: [],
    reference: { scheduleType: "morning_prayer_family" }
  }
};

const mediaRolePattern =
  /音控|導播|直播|投影(?:電腦)?|前攝影|後攝影|手機拍照|機動|單眼相機|音效(?:電腦)?|計時/u;
const mediaTeamPattern = /影視團隊|影音團隊|媒體團隊|影視/u;
const familyPattern = /(?:家族|家園)(?:\s*\d+)?/u;
const familyRolePattern = /服事家族|哪個家族|家族是誰/u;
const genericMorningPrayerPattern = /晨更|仙履奇緣/u;

export function scheduleDomainCandidate(domainKey: string): ResolutionCandidate | undefined {
  return Object.values(candidates).find((candidate) => candidate.domainKey === domainKey);
}

export function resolveScheduleDomain(input: {
  text: string;
  requestedDomainKey?: string;
  activeDomainKey?: string;
  availableDomainKeys?: string[];
}): ResolutionDecision {
  const fixed = input.requestedDomainKey || input.activeDomainKey;
  if (fixed) {
    const candidate = scheduleDomainCandidate(fixed);
    return decideResolution(candidate ? [candidate] : []);
  }

  const text = input.text.normalize("NFKC");
  const eligible = new Set(input.availableDomainKeys ?? Object.values(SCHEDULE_DOMAIN_KEYS));
  if (mediaTeamPattern.test(text) || mediaRolePattern.test(text)) {
    return decideResolution(eligible.has(candidates.media.domainKey) ? [candidates.media] : []);
  }
  if (familyRolePattern.test(text) || familyPattern.test(text)) {
    return decideResolution(eligible.has(candidates.family.domainKey) ? [candidates.family] : []);
  }
  if (genericMorningPrayerPattern.test(text)) {
    return decideResolution(
      [candidates.media, candidates.family].filter((candidate) => eligible.has(candidate.domainKey))
    );
  }
  return { status: "not_found" };
}

export function scheduleDomainChoices(): ResolutionCandidate[] {
  return [candidates.media, candidates.family];
}
