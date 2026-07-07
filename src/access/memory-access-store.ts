import { randomUUID } from "node:crypto";

import type {
  AccessAuditInput,
  AccessAuditEvent,
  AddGroupFunctionGrantInput,
  DisableGroupFunctionGrantInput,
  GroupFunctionGrant,
  AccessPrincipal,
  AccessPrincipalType,
  AccessStore,
  AddPrincipalInput,
  DisablePrincipalInput
} from "./types.js";

export interface InMemoryAccessStoreOptions {
  principals?: AccessPrincipal[];
  groupFunctionGrants?: GroupFunctionGrant[];
}

export class InMemoryAccessStore implements AccessStore {
  private readonly principals = new Map<string, AccessPrincipal>();
  private readonly groupFunctionGrants = new Map<string, GroupFunctionGrant>();
  readonly audit: AccessAuditEvent[] = [];

  constructor(options: InMemoryAccessStoreOptions = {}) {
    for (const principal of options.principals ?? []) {
      this.principals.set(principal.id, { ...principal });
    }
    for (const grant of options.groupFunctionGrants ?? []) {
      this.groupFunctionGrants.set(grant.id, { ...grant });
    }
  }

  async hasActivePrincipal(
    profileName: string,
    type: AccessPrincipalType,
    principalId: string
  ): Promise<boolean> {
    return Array.from(this.principals.values()).some(
      (principal) =>
        principal.profileName === profileName &&
        principal.type === type &&
        principal.principalId === principalId &&
        !principal.disabledAt
    );
  }

  async listPrincipals(profileName: string): Promise<AccessPrincipal[]> {
    return Array.from(this.principals.values())
      .filter((principal) => principal.profileName === profileName && !principal.disabledAt)
      .sort((a, b) => a.type.localeCompare(b.type) || a.principalId.localeCompare(b.principalId))
      .map((principal) => ({ ...principal }));
  }

  async addPrincipal(input: AddPrincipalInput): Promise<AccessPrincipal> {
    const existing = Array.from(this.principals.values()).find(
      (principal) =>
        principal.profileName === input.profileName &&
        principal.type === input.type &&
        principal.principalId === input.principalId
    );
    if (existing) {
      const enabled = {
        ...existing,
        displayName: input.displayName ?? existing.displayName,
        disabledAt: undefined,
        disabledBy: undefined
      };
      this.principals.set(existing.id, enabled);
      return { ...enabled };
    }

    const principal: AccessPrincipal = {
      id: randomUUID(),
      profileName: input.profileName,
      type: input.type,
      principalId: input.principalId,
      displayName: input.displayName,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy
    };
    this.principals.set(principal.id, principal);
    return { ...principal };
  }

  async disablePrincipal(input: DisablePrincipalInput): Promise<boolean> {
    const existing = Array.from(this.principals.values()).find(
      (principal) =>
        principal.profileName === input.profileName &&
        principal.type === input.type &&
        principal.principalId === input.principalId &&
        !principal.disabledAt
    );
    if (!existing) {
      return false;
    }
    this.principals.set(existing.id, {
      ...existing,
      disabledAt: new Date().toISOString(),
      disabledBy: input.disabledBy
    });
    return true;
  }

  async recordAudit(input: AccessAuditInput): Promise<void> {
    this.audit.unshift({
      id: randomUUID(),
      profileName: input.profileName,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata,
      createdAt: new Date().toISOString()
    });
  }

  async listAuditEvents(profileName: string, limit: number): Promise<AccessAuditEvent[]> {
    return this.audit
      .filter((event) => event.profileName === profileName)
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  async listGroupFunctionGrants(profileName: string, groupId: string) {
    return Array.from(this.groupFunctionGrants.values())
      .filter(
        (grant) =>
          grant.profileName === profileName && grant.groupId === groupId && !grant.disabledAt
      )
      .map((grant) => grant.functionName)
      .sort();
  }

  async listAllGroupFunctionGrants(profileName: string): Promise<GroupFunctionGrant[]> {
    return Array.from(this.groupFunctionGrants.values())
      .filter((grant) => grant.profileName === profileName && !grant.disabledAt)
      .sort(
        (a, b) => a.groupId.localeCompare(b.groupId) || a.functionName.localeCompare(b.functionName)
      )
      .map((grant) => ({ ...grant }));
  }

  async addGroupFunctionGrant(input: AddGroupFunctionGrantInput): Promise<GroupFunctionGrant> {
    const existing = Array.from(this.groupFunctionGrants.values()).find(
      (grant) =>
        grant.profileName === input.profileName &&
        grant.groupId === input.groupId &&
        grant.functionName === input.functionName
    );
    if (existing) {
      const enabled: GroupFunctionGrant = {
        ...existing,
        disabledAt: undefined,
        disabledBy: undefined
      };
      this.groupFunctionGrants.set(existing.id, enabled);
      return { ...enabled };
    }

    const grant: GroupFunctionGrant = {
      id: randomUUID(),
      profileName: input.profileName,
      groupId: input.groupId,
      functionName: input.functionName,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy
    };
    this.groupFunctionGrants.set(grant.id, grant);
    return { ...grant };
  }

  async disableGroupFunctionGrant(input: DisableGroupFunctionGrantInput): Promise<boolean> {
    const existing = Array.from(this.groupFunctionGrants.values()).find(
      (grant) =>
        grant.profileName === input.profileName &&
        grant.groupId === input.groupId &&
        grant.functionName === input.functionName &&
        !grant.disabledAt
    );
    if (!existing) {
      return false;
    }
    this.groupFunctionGrants.set(existing.id, {
      ...existing,
      disabledAt: new Date().toISOString(),
      disabledBy: input.disabledBy
    });
    return true;
  }
}
