import type { CapabilityName } from "../capabilities/names.js";

export type AccessPrincipalType = "admin" | "user" | "group";
export type RolePrincipalType = "user" | "group";

export interface AccessRole {
  id: string;
  profileName: string;
  roleKey: string;
  displayName: string;
}

export interface UpsertRoleInput {
  profileName: string;
  roleKey: string;
  displayName: string;
}

export interface BindRoleInput {
  profileName: string;
  principalType: RolePrincipalType;
  principalId: string;
  roleId: string;
}

export interface AccessPrincipal {
  id: string;
  profileName: string;
  type: AccessPrincipalType;
  principalId: string;
  displayName?: string;
  createdAt: string;
  createdBy: string;
  disabledAt?: string;
  disabledBy?: string;
  lastSuccessCapabilityName?: CapabilityName;
  lastSuccessAt?: string;
}

export interface AccessAuditEvent {
  id: string;
  profileName: string;
  actorUserId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface GroupFunctionGrant {
  id: string;
  profileName: string;
  groupId: string;
  functionName: CapabilityName;
  createdAt: string;
  createdBy: string;
  disabledAt?: string;
  disabledBy?: string;
}

export interface UserFunctionGrant {
  id: string;
  profileName: string;
  userId: string;
  functionName: CapabilityName;
  createdAt: string;
  createdBy: string;
  disabledAt?: string;
  disabledBy?: string;
}

export interface AddPrincipalInput {
  profileName: string;
  type: AccessPrincipalType;
  principalId: string;
  displayName?: string;
  createdBy: string;
}

export interface DisablePrincipalInput {
  profileName: string;
  type: AccessPrincipalType;
  principalId: string;
  disabledBy: string;
}

export interface RecordPrincipalSuccessInput {
  profileName: string;
  type: "user" | "group";
  principalId: string;
  functionName: CapabilityName;
  occurredAt: string;
}

export interface AccessAuditInput {
  profileName: string;
  actorUserId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface AddGroupFunctionGrantInput {
  profileName: string;
  groupId: string;
  functionName: CapabilityName;
  createdBy: string;
}

export interface DisableGroupFunctionGrantInput {
  profileName: string;
  groupId: string;
  functionName: CapabilityName;
  disabledBy: string;
}

export interface AddUserFunctionGrantInput {
  profileName: string;
  userId: string;
  functionName: CapabilityName;
  createdBy: string;
}

export interface DisableUserFunctionGrantInput {
  profileName: string;
  userId: string;
  functionName: CapabilityName;
  disabledBy: string;
}

export interface AccessStore {
  hasActivePrincipal(
    profileName: string,
    type: AccessPrincipalType,
    principalId: string
  ): Promise<boolean>;
  listPrincipals(
    profileName: string,
    options?: { includeDisabled?: boolean }
  ): Promise<AccessPrincipal[]>;
  addPrincipal(input: AddPrincipalInput): Promise<AccessPrincipal>;
  disablePrincipal(input: DisablePrincipalInput): Promise<boolean>;
  recordPrincipalSuccess(input: RecordPrincipalSuccessInput): Promise<void>;
  recordAudit(input: AccessAuditInput): Promise<void>;
  listAuditEvents(profileName: string, limit: number): Promise<AccessAuditEvent[]>;
  listGroupFunctionGrants(profileName: string, groupId: string): Promise<CapabilityName[]>;
  listAllGroupFunctionGrants(profileName: string): Promise<GroupFunctionGrant[]>;
  addGroupFunctionGrant(input: AddGroupFunctionGrantInput): Promise<GroupFunctionGrant>;
  disableGroupFunctionGrant(input: DisableGroupFunctionGrantInput): Promise<boolean>;
  listUserFunctionGrants(profileName: string, userId: string): Promise<CapabilityName[]>;
  listAllUserFunctionGrants(profileName: string): Promise<UserFunctionGrant[]>;
  addUserFunctionGrant(input: AddUserFunctionGrantInput): Promise<UserFunctionGrant>;
  disableUserFunctionGrant(input: DisableUserFunctionGrantInput): Promise<boolean>;
  upsertRole(input: UpsertRoleInput): Promise<AccessRole>;
  bindRoleCapability(roleId: string, capability: string): Promise<void>;
  bindRoleToPrincipal(input: BindRoleInput): Promise<void>;
  listPrincipalCapabilities(
    profileName: string,
    principalType: RolePrincipalType,
    principalId: string
  ): Promise<string[]>;
}
