# RBAC Capability Model

This is the role/capability model for the catalog-driven helper profile. Its
persistence and additive function-capability resolution are active; production
role definitions and role bindings are intentionally not seeded.

## Goal

Avoid granting every new function one by one to every user or group. New
features should bind to capabilities, and operators should grant roles that
bundle those capabilities.

## Current v1 behavior

- `profile.enabledFunctions` remains the profile-global function allowlist.
- Read functions are available by default to non-admin allowed users/groups.
- Write functions are not default user capabilities; they require admin or
  explicit user/group function grants.
- Existing user/group function grants remain the override mechanism.
- Profile-scoped role, role-capability, and principal-role tables are available.
- Role-derived `function:<functionName>:execute` capabilities are additive to
  profile defaults and explicit user/group grants.
- Catalog source `capabilities.read` and `capabilities.write` describe source
  intent. The attachment publish path enforces source write presence; mapping
  role-derived source/item-kind capabilities into every handler is reserved for
  the role administration phase.

## Target model

```text
principal
  -> role_binding
  -> role
  -> capability_binding
  -> capability
```

Principals are profile-scoped:

- `profileName/userId`
- `profileName/groupId`

Capabilities are profile-scoped strings with these recommended namespaces:

- `function:<functionName>:execute`
- `source:<sourceKey>:read`
- `source:<sourceKey>:write`
- `itemKind:<itemKind>:read`
- `itemKind:<itemKind>:write`
- `admin:<actionName>:execute`

Roles are deployment-owned or admin-managed bundles, for example:

- `helper.viewer`: internal read functions and allowed read catalog sources.
- `helper.media_writer`: `save_resource`, `ppt_slide`, `pop_sheet`, and
  `hymn_sheet` write capabilities.
- `helper.schedule_writer`: `save_schedule` and future structured schedule write
  capabilities.
- `helper.admin_operator`: safe admin actions that do not require bootstrap
  superadmin.

## Resolution order

Effective function capabilities are resolved in this order:

1. Bootstrap superadmin bypass for admin-only actions.
2. Profile-global defaults.
3. Role-derived capabilities from direct user bindings.
4. Role-derived capabilities from current group bindings.
5. Existing explicit function grants as additive compatibility overrides.
6. Explicit deny support only if a future use case requires it.

The runtime/router must only see capabilities already resolved for the current
profile, LINE source, and requester. The LLM must never decide permissions.

## Function and catalog mapping

Each canonical function should map to a function execute capability:

- `query_schedule` -> `function:query_schedule:execute`
- `find_ppt_slides` -> `function:find_ppt_slides:execute`
- `find_sheet_music` -> `function:find_sheet_music:execute`
- `find_resource` -> `function:find_resource:execute`
- `query_wikipedia` -> `function:query_wikipedia:execute`
- `save_schedule` -> `function:save_schedule:execute`
- `save_resource` -> `function:save_resource:execute`

Catalog search should also check source/item-kind read capabilities before
returning results. Catalog writes should check both:

- the function execute capability, such as `function:save_resource:execute`;
- the target write capability, such as `source:ppt_slides:write` or
  `itemKind:ppt_slide:write`.

## Current non-goals

- No LINE admin wizard to create roles yet.
- No change to existing `/function-grant` and `/function-user-grant` commands.
- No role inheritance.
- No LLM-visible role or grant details.

## Role-administration gate

Before creating production role data or exposing role administration:

1. Add effective-capability resolver tests for direct, group, admin, and mixed
   user/group contexts.
2. Map source/item-kind read and write capabilities into catalog handler
   contexts without making the LLM a policy decision-maker.
3. Keep existing function grants as additive overrides until the operator has a
   clean replacement path.
4. Update `/function-scopes` or add role-specific admin actions only after the
   role model is exercised by tests.
