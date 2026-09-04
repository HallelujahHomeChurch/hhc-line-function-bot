import type { CapabilityName } from "../capabilities/names.js";
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

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
}

export class PostgresAccessStore implements AccessStore {
  constructor(private readonly db: PgQueryable) {}

  async hasActivePrincipal(
    profileName: string,
    type: AccessPrincipalType,
    principalId: string
  ): Promise<boolean> {
    const result = await this.db.query(
      `
      select 1
      from access_principals
      where profile_name = $1
        and principal_type = $2
        and principal_id = $3
        and disabled_at is null
      limit 1
      `,
      [profileName, type, principalId]
    );
    return result.rows.length > 0;
  }

  async listPrincipals(
    profileName: string,
    options: { includeDisabled?: boolean } = {}
  ): Promise<AccessPrincipal[]> {
    const result = await this.db.query(
      `
      select *
      from access_principals
      where profile_name = $1
        ${options.includeDisabled ? "" : "and disabled_at is null"}
      order by principal_type, principal_id
      `,
      [profileName]
    );
    return result.rows.map(mapPrincipal);
  }

  async addPrincipal(input: AddPrincipalInput): Promise<AccessPrincipal> {
    const id = randomUUID();
    const result = await this.db.query(
      `
      insert into access_principals
        (id, profile_name, principal_type, principal_id, display_name, created_by)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (profile_name, principal_type, principal_id)
      do update set
        display_name = coalesce(excluded.display_name, access_principals.display_name),
        disabled_at = null,
        disabled_by = null
      returning *
      `,
      [
        id,
        input.profileName,
        input.type,
        input.principalId,
        input.displayName ?? null,
        input.createdBy
      ]
    );
    return mapPrincipal(result.rows[0]);
  }

  async disablePrincipal(input: DisablePrincipalInput): Promise<boolean> {
    const result = await this.db.query(
      `
      update access_principals
      set disabled_at = now(), disabled_by = $4
      where profile_name = $1
        and principal_type = $2
        and principal_id = $3
        and disabled_at is null
      returning id
      `,
      [input.profileName, input.type, input.principalId, input.disabledBy]
    );
    return result.rows.length > 0;
  }

  async recordPrincipalSuccess(input: RecordPrincipalSuccessInput): Promise<void> {
    await this.db.query(
      `
      update access_principals
      set last_success_function_name = $4, last_success_at = $5
      where profile_name = $1
        and principal_type = $2
        and principal_id = $3
        and disabled_at is null
        and (last_success_at is null or last_success_at <= $5)
      `,
      [input.profileName, input.type, input.principalId, input.functionName, input.occurredAt]
    );
  }

  async recordAudit(input: AccessAuditInput): Promise<void> {
    await this.db.query(
      `
      insert into access_audit_events
        (id, profile_name, actor_user_id, action, target_type, target_id, metadata)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        randomUUID(),
        input.profileName,
        input.actorUserId,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
  }

  async listAuditEvents(profileName: string, limit: number): Promise<AccessAuditEvent[]> {
    const result = await this.db.query(
      `
      select *
      from access_audit_events
      where profile_name = $1
      order by created_at desc
      limit $2
      `,
      [profileName, limit]
    );
    return result.rows.map(mapAuditEvent);
  }

  async listGroupFunctionGrants(profileName: string, groupId: string): Promise<CapabilityName[]> {
    const result = await this.db.query(
      `
      select function_name
      from access_group_function_grants
      where profile_name = $1
        and group_id = $2
        and disabled_at is null
      order by function_name
      `,
      [profileName, groupId]
    );
    return result.rows.map((row) => row.function_name as CapabilityName);
  }

  async listAllGroupFunctionGrants(profileName: string): Promise<GroupFunctionGrant[]> {
    const result = await this.db.query(
      `
      select *
      from access_group_function_grants
      where profile_name = $1
        and disabled_at is null
      order by group_id, function_name
      `,
      [profileName]
    );
    return result.rows.map(mapGroupFunctionGrant);
  }

  async addGroupFunctionGrant(input: AddGroupFunctionGrantInput): Promise<GroupFunctionGrant> {
    const result = await this.db.query(
      `
      insert into access_group_function_grants
        (id, profile_name, group_id, function_name, created_by)
      values ($1, $2, $3, $4, $5)
      on conflict (profile_name, group_id, function_name)
      do update set
        disabled_at = null,
        disabled_by = null
      returning *
      `,
      [randomUUID(), input.profileName, input.groupId, input.functionName, input.createdBy]
    );
    return mapGroupFunctionGrant(result.rows[0]);
  }

  async disableGroupFunctionGrant(input: DisableGroupFunctionGrantInput): Promise<boolean> {
    const result = await this.db.query(
      `
      update access_group_function_grants
      set disabled_at = now(), disabled_by = $4
      where profile_name = $1
        and group_id = $2
        and function_name = $3
        and disabled_at is null
      returning id
      `,
      [input.profileName, input.groupId, input.functionName, input.disabledBy]
    );
    return result.rows.length > 0;
  }

  async listUserFunctionGrants(profileName: string, userId: string): Promise<CapabilityName[]> {
    const result = await this.db.query(
      `
      select function_name
      from access_user_function_grants
      where profile_name = $1
        and user_id = $2
        and disabled_at is null
      order by function_name
      `,
      [profileName, userId]
    );
    return result.rows.map((row) => row.function_name as CapabilityName);
  }

  async listAllUserFunctionGrants(profileName: string): Promise<UserFunctionGrant[]> {
    const result = await this.db.query(
      `
      select *
      from access_user_function_grants
      where profile_name = $1
        and disabled_at is null
      order by user_id, function_name
      `,
      [profileName]
    );
    return result.rows.map(mapUserFunctionGrant);
  }

  async addUserFunctionGrant(input: AddUserFunctionGrantInput): Promise<UserFunctionGrant> {
    const result = await this.db.query(
      `
      insert into access_user_function_grants
        (id, profile_name, user_id, function_name, created_by)
      values ($1, $2, $3, $4, $5)
      on conflict (profile_name, user_id, function_name)
      do update set
        disabled_at = null,
        disabled_by = null
      returning *
      `,
      [randomUUID(), input.profileName, input.userId, input.functionName, input.createdBy]
    );
    return mapUserFunctionGrant(result.rows[0]);
  }

  async disableUserFunctionGrant(input: DisableUserFunctionGrantInput): Promise<boolean> {
    const result = await this.db.query(
      `
      update access_user_function_grants
      set disabled_at = now(), disabled_by = $4
      where profile_name = $1
        and user_id = $2
        and function_name = $3
        and disabled_at is null
      returning id
      `,
      [input.profileName, input.userId, input.functionName, input.disabledBy]
    );
    return result.rows.length > 0;
  }

  async upsertRole(input: UpsertRoleInput): Promise<AccessRole> {
    const result = await this.db.query(
      `
      insert into access_roles (id, profile_name, role_key, display_name)
      values ($1, $2, $3, $4)
      on conflict (profile_name, role_key)
      do update set display_name = excluded.display_name
      returning *
      `,
      [randomUUID(), input.profileName, input.roleKey, input.displayName]
    );
    return mapRole(result.rows[0]);
  }

  async bindRoleCapability(roleId: string, capability: string): Promise<void> {
    await this.db.query(
      `
      insert into access_role_capability_bindings (role_id, capability)
      values ($1, $2)
      on conflict do nothing
      `,
      [roleId, capability]
    );
  }

  async bindRoleToPrincipal(input: BindRoleInput): Promise<void> {
    await this.db.query(
      `
      insert into access_principal_role_bindings
        (id, profile_name, principal_type, principal_id, role_id)
      values ($1, $2, $3, $4, $5)
      on conflict do nothing
      `,
      [randomUUID(), input.profileName, input.principalType, input.principalId, input.roleId]
    );
  }

  async listPrincipalCapabilities(
    profileName: string,
    principalType: RolePrincipalType,
    principalId: string
  ): Promise<string[]> {
    const result = await this.db.query(
      `
      select distinct capability
      from access_principal_role_bindings bindings
      join access_roles roles
        on roles.id = bindings.role_id
       and roles.profile_name = bindings.profile_name
      join access_role_capability_bindings capabilities
        on capabilities.role_id = roles.id
      where bindings.profile_name = $1
        and bindings.principal_type = $2
        and bindings.principal_id = $3
      order by capability
      `,
      [profileName, principalType, principalId]
    );
    return result.rows.map((row) => String(row.capability));
  }
}

function mapRole(row: Record<string, unknown>): AccessRole {
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    roleKey: String(row.role_key),
    displayName: String(row.display_name)
  };
}

function mapPrincipal(row: Record<string, unknown>): AccessPrincipal {
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    type: row.principal_type as AccessPrincipalType,
    principalId: String(row.principal_id),
    displayName: optionalString(row.display_name),
    createdAt: toIso(row.created_at),
    createdBy: String(row.created_by),
    disabledAt: optionalIso(row.disabled_at),
    disabledBy: optionalString(row.disabled_by),
    lastSuccessCapabilityName: optionalString(row.last_success_function_name) as
      CapabilityName | undefined,
    lastSuccessAt: optionalIso(row.last_success_at)
  };
}

function mapAuditEvent(row: Record<string, unknown>): AccessAuditEvent {
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    actorUserId: String(row.actor_user_id),
    action: String(row.action),
    targetType: optionalString(row.target_type),
    targetId: optionalString(row.target_id),
    metadata: jsonRecord(row.metadata),
    createdAt: toIso(row.created_at)
  };
}

function mapGroupFunctionGrant(row: Record<string, unknown>): GroupFunctionGrant {
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    groupId: String(row.group_id),
    functionName: row.function_name as CapabilityName,
    createdAt: toIso(row.created_at),
    createdBy: String(row.created_by),
    disabledAt: optionalIso(row.disabled_at),
    disabledBy: optionalString(row.disabled_by)
  };
}

function mapUserFunctionGrant(row: Record<string, unknown>): UserFunctionGrant {
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    userId: String(row.user_id),
    functionName: row.function_name as CapabilityName,
    createdAt: toIso(row.created_at),
    createdBy: String(row.created_by),
    disabledAt: optionalIso(row.disabled_at),
    disabledBy: optionalString(row.disabled_by)
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalIso(value: unknown): string | undefined {
  return value ? toIso(value) : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}
