import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import fixtureJson from "./producer-fixture.json" with { type: "json" };

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const accountUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

type AuditAction = (typeof fixtureJson.actions)[number]["action"];
type AuditActor = { type: "user"; id: string } | { type: "service"; id: string };

export type AuditEvent = {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  requestId: string;
  sourceService: "hhc-line-function-bot";
  actorType: AuditActor["type"];
  actorId: string;
  action: AuditAction;
  category: "media_sync";
  resourceOwnerService: "hhc-line-function-bot";
  resourceType: "binding" | "binding_code";
  resourceId: string;
  outcome: "success";
  severity: "info";
  metadataClassification: "internal";
  retentionClass: "security";
  metadata: Record<string, never>;
};

export function loadAuditFixture(): typeof fixtureJson {
  const canonical = JSON.stringify({ ...fixtureJson, checksum: "" });
  const checksum = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  if (fixtureJson.sourceService !== "hhc-line-function-bot" || checksum !== fixtureJson.checksum) {
    throw new Error("audit_fixture_checksum_mismatch");
  }
  return fixtureJson;
}

export function createAuditEvent(input: {
  action: AuditAction;
  resourceId: string;
  actor: AuditActor;
  requestId: string;
  now?: Date;
  eventId?: string;
}): AuditEvent {
  const fixture = loadAuditFixture();
  const contract = fixture.actions.find(({ action }) => action === input.action);
  const eventId = input.eventId ?? randomUUID();
  if (
    !contract ||
    !uuidV4.test(eventId) ||
    !uuidV4.test(input.resourceId) ||
    !validRequestId(input.requestId) ||
    !contract.actorTypes.includes(input.actor.type) ||
    (input.actor.type === "user" && !accountUuid.test(input.actor.id)) ||
    (input.actor.type === "service" && !contract.servicePrincipals.includes(input.actor.id))
  ) {
    throw new Error("audit_event_invalid");
  }
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: (input.now ?? new Date()).toISOString(),
    requestId: input.requestId,
    sourceService: "hhc-line-function-bot",
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: contract.action,
    category: contract.category,
    resourceOwnerService: contract.resourceOwnerService,
    resourceType: contract.resourceType,
    resourceId: input.resourceId,
    outcome: contract.outcome,
    severity: contract.severity,
    metadataClassification: contract.metadataClassification,
    retentionClass: contract.retentionClass,
    metadata: {}
  } as AuditEvent;
}

function validRequestId(value: string): boolean {
  return (
    requestIdPattern.test(value) &&
    isIP(value) === 0 &&
    !value.includes("@") &&
    !value.includes("://") &&
    !credentialShaped(value)
  );
}

function credentialShaped(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 && parts.length !== 5) return false;
  return parts.every((part) => {
    if (!/^[A-Za-z0-9_-]+$/u.test(part)) return false;
    try {
      return Buffer.from(part, "base64url").toString("base64url") === part;
    } catch {
      return false;
    }
  });
}
