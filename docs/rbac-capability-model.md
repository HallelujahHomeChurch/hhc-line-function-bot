# RBAC Capability Model

This is the target access model for the helper profile after the catalog-driven
function surface stabilizes. It is a design contract, not an active migration in
v1.

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
- Catalog source `capabilities.read` and `capabilities.write` describe source
  intent, but v1 only enforces source write presence in the attachment publish
  path. They are not yet full RBAC bindings.

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
- `profileName/adminUserId`

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

When implemented, effective capabilities should be resolved in this order:

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

## Non-goals for v1

- No schema migration for role tables yet.
- No LINE admin wizard to create roles yet.
- No change to existing `/function-grant` and `/function-user-grant` commands.
- No role inheritance.
- No LLM-visible role or grant details.

## Implementation gate

Before enabling roles in production:

1. Add role tables and access-store methods behind tests.
2. Add effective-capability resolver tests for direct, group, admin, and mixed
   user/group contexts.
3. Keep existing function grants as additive overrides until the operator has a
   clean replacement path.
4. Update `/function-scopes` or add role-specific admin actions only after the
   role model is exercised by tests.
