import { randomUUID } from "node:crypto";

import type {
  AccessAuditInput,
  AccessAuditEvent,
  AddGroupFunctionGrantInput,
  AddUserFunctionGrantInput,
  DisableGroupFunctionGrantInput,
  DisableUserFunctionGrantInput,
  GroupFunctionGrant,
  UserFunctionGrant,
  AccessPrincipal,
  AccessPrincipalType,
  AccessStore,
  AddPrincipalInput,
  DisablePrincipalInput,
  AccessRole,
  BindRoleInput,
  UpsertRoleInput,
  RolePrincipalType,
  RecordPrincipalSuccessInput
} from "./types.js";

export interface InMemoryAccessStoreOptions {
  principals?: AccessPrincipal[];
  groupFunctionGrants?: GroupFunctionGrant[];
  userFunctionGrants?: UserFunctionGrant[];
}

export class InMemoryAccessStore implements AccessStore {
  private readonly principals = new Map<string, AccessPrincipal>();
  private readonly groupFunctionGrants = new Map<string, GroupFunctionGrant>();
  private readonly userFunctionGrants = new Map<string, UserFunctionGrant>();
  private readonly roles = new Map<string, AccessRole>();
  private readonly roleCapabilities = new Map<string, Set<string>>();
  private readonly roleBindings: BindRoleInput[] = [];
  readonly audit: AccessAuditEvent[] = [];

  constructor(options: InMemoryAccessStoreOptions = {}) {
    for (const principal of options.principals ?? []) {
      this.principals.set(principal.id, { ...principal });
    }
    for (const grant of options.groupFunctionGrants ?? []) {
      this.groupFunctionGrants.set(grant.id, { ...grant });
    }
    for (const grant of options.userFunctionGrants ?? []) {
      this.userFunctionGrants.set(grant.id, { ...grant });
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

  async listPrincipals(
    profileName: string,
    options: { includeDisabled?: boolean } = {}
  ): Promise<AccessPrincipal[]> {
    return Array.from(this.principals.values())
      .filter(
        (principal) =>
          principal.profileName === profileName &&
          (options.includeDisabled || !principal.disabledAt)
      )
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

  async recordPrincipalSuccess(input: RecordPrincipalSuccessInput): Promise<void> {
    const existing = Array.from(this.principals.values()).find(
      (principal) =>
        principal.profileName === input.profileName &&
        principal.type === input.type &&
        principal.principalId === input.principalId &&
        !principal.disabledAt
    );
    if (
      !existing ||
      (existing.lastSuccessAt &&
        new Date(existing.lastSuccessAt).getTime() > new Date(input.occurredAt).getTime())
    ) {
      return;
    }
    this.principals.set(existing.id, {
      ...existing,
      lastSuccessCapabilityName: input.functionName,
      lastSuccessAt: input.occurredAt
    });
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

  async listUserFunctionGrants(profileName: string, userId: string) {
    return Array.from(this.userFunctionGrants.values())
      .filter(
        (grant) => grant.profileName === profileName && grant.userId === userId && !grant.disabledAt
      )
      .map((grant) => grant.functionName)
      .sort();
  }

  async listAllUserFunctionGrants(profileName: string): Promise<UserFunctionGrant[]> {
    return Array.from(this.userFunctionGrants.values())
      .filter((grant) => grant.profileName === profileName && !grant.disabledAt)
      .sort(
        (a, b) => a.userId.localeCompare(b.userId) || a.functionName.localeCompare(b.functionName)
      )
      .map((grant) => ({ ...grant }));
  }

  async addUserFunctionGrant(input: AddUserFunctionGrantInput): Promise<UserFunctionGrant> {
    const existing = Array.from(this.userFunctionGrants.values()).find(
      (grant) =>
        grant.profileName === input.profileName &&
        grant.userId === input.userId &&
        grant.functionName === input.functionName
    );
    if (existing) {
      const enabled: UserFunctionGrant = {
        ...existing,
        disabledAt: undefined,
        disabledBy: undefined
      };
      this.userFunctionGrants.set(existing.id, enabled);
      return { ...enabled };
    }

    const grant: UserFunctionGrant = {
      id: randomUUID(),
      profileName: input.profileName,
      userId: input.userId,
      functionName: input.functionName,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy
    };
    this.userFunctionGrants.set(grant.id, grant);
    return { ...grant };
  }

  async disableUserFunctionGrant(input: DisableUserFunctionGrantInput): Promise<boolean> {
    const existing = Array.from(this.userFunctionGrants.values()).find(
      (grant) =>
        grant.profileName === input.profileName &&
        grant.userId === input.userId &&
        grant.functionName === input.functionName &&
        !grant.disabledAt
    );
    if (!existing) {
      return false;
    }
    this.userFunctionGrants.set(existing.id, {
      ...existing,
      disabledAt: new Date().toISOString(),
      disabledBy: input.disabledBy
    });
    return true;
  }

  async upsertRole(input: UpsertRoleInput): Promise<AccessRole> {
    const existing = Array.from(this.roles.values()).find(
      (role) => role.profileName === input.profileName && role.roleKey === input.roleKey
    );
    const role = {
      id: existing?.id ?? randomUUID(),
      profileName: input.profileName,
      roleKey: input.roleKey,
      displayName: input.displayName
    };
    this.roles.set(role.id, role);
    return { ...role };
  }

  async bindRoleCapability(roleId: string, capability: string): Promise<void> {
    if (!this.roles.has(roleId)) {
      throw new Error(`access_role_not_found:${roleId}`);
    }
    const capabilities = this.roleCapabilities.get(roleId) ?? new Set<string>();
    capabilities.add(capability);
    this.roleCapabilities.set(roleId, capabilities);
  }

  async bindRoleToPrincipal(input: BindRoleInput): Promise<void> {
    const role = this.roles.get(input.roleId);
    if (!role || role.profileName !== input.profileName) {
      throw new Error(`access_role_profile_mismatch:${input.roleId}`);
    }
    if (
      !this.roleBindings.some(
        (binding) =>
          binding.profileName === input.profileName &&
          binding.principalType === input.principalType &&
          binding.principalId === input.principalId &&
          binding.roleId === input.roleId
      )
    ) {
      this.roleBindings.push({ ...input });
    }
  }

  async listPrincipalCapabilities(
    profileName: string,
    principalType: RolePrincipalType,
    principalId: string
  ): Promise<string[]> {
    const capabilities = new Set<string>();
    for (const binding of this.roleBindings) {
      if (
        binding.profileName === profileName &&
        binding.principalType === principalType &&
        binding.principalId === principalId
      ) {
        for (const capability of this.roleCapabilities.get(binding.roleId) ?? []) {
          capabilities.add(capability);
        }
      }
    }
    return Array.from(capabilities).sort();
  }
}
