import type { FunctionName } from "../types.js";

export type AccessPrincipalType = "admin" | "user" | "group";

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
  functionName: FunctionName;
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
  functionName: FunctionName;
  createdBy: string;
}

export interface DisableGroupFunctionGrantInput {
  profileName: string;
  groupId: string;
  functionName: FunctionName;
  disabledBy: string;
}

export interface AccessStore {
  hasActivePrincipal(
    profileName: string,
    type: AccessPrincipalType,
    principalId: string
  ): Promise<boolean>;
  listPrincipals(profileName: string): Promise<AccessPrincipal[]>;
  addPrincipal(input: AddPrincipalInput): Promise<AccessPrincipal>;
  disablePrincipal(input: DisablePrincipalInput): Promise<boolean>;
  recordAudit(input: AccessAuditInput): Promise<void>;
  listAuditEvents(profileName: string, limit: number): Promise<AccessAuditEvent[]>;
  listGroupFunctionGrants(profileName: string, groupId: string): Promise<FunctionName[]>;
  listAllGroupFunctionGrants(profileName: string): Promise<GroupFunctionGrant[]>;
  addGroupFunctionGrant(input: AddGroupFunctionGrantInput): Promise<GroupFunctionGrant>;
  disableGroupFunctionGrant(input: DisableGroupFunctionGrantInput): Promise<boolean>;
}
