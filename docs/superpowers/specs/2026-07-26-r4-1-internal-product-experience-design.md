# R4.1 Internal Product Experience Design

## Status

Approved product direction, ready for implementation planning after written
spec review.

This document refines the approved R4.1 milestone in
`2026-07-26-single-church-optimization-roadmap-design.md`. The roadmap remains
authoritative. This spec records only the implementation-level decisions needed
to deliver that milestone.

## Outcome

An authorized church member can discover what the bot can currently do,
complete a first useful task without engineering documentation, and receive one
honest next action for every controlled result class.

The product experience must remain a projection of existing authority. It must
never create authority, advertise unavailable functions, expose implementation
details, or introduce a second routing or policy system.

## Confirmed Product Decisions

- The preferred onboarding reads are, in order:
  1. query the next service schedule;
  2. find sheet music;
  3. find presentation slides.
- Registration completion includes concise text and at most three LINE Quick
  Replies.
- If one of the preferred reads is unavailable to the current requester, the
  projection substitutes the next currently authorized capability.
- `/help` lists the complete effective capability set, grouped into reads and
  writes, while exposing at most three Quick Replies.
- Natural-language capability introduction and `/help` use the same projection.
- Identity-only introduction remains short and does not include the capability
  catalog.
- A write capability is shown only when the requester has effective write
  authority in the current source.
- Every non-success result has at most one bounded next action.
- Existing administrator commands are extended instead of adding parallel
  commands.
- No new database service or projection table is introduced.
- No recruited human acceptance session is required.

## Current Gaps

The current runtime already computes an effective profile for the requester and
LINE source, but presentation is split across unrelated call sites:

- registration completion returns only a short success sentence;
- `/help` is static and does not consume the effective capability set;
- natural-language capability introduction reads `enabledFunctions` but samples
  examples randomly;
- Quick Replies are not produced by capability introduction;
- group registration replies expose the LINE group ID;
- result copy is not governed by one product-level state contract;
- effective-function calculation lives inside the LINE transport module;
- administrator group listings do not include effective functions or the most
  recent privacy-safe success;
- source administration does not consistently state ownership and freshness
  responsibility.

## Architecture

### Authority Boundary

The existing access and function policy remains authoritative:

1. resolve profile defaults;
2. apply admin, user, group, and role grants;
3. apply function principal and LINE-source policy;
4. produce the effective function set for the current profile, source, and
   requester.

R4.1 extracts this calculation from `webhook-routes.ts` into an application
service with an explicit access-store port. The LINE transport calls the
service; it does not reproduce the policy.

The resolver returns an effective access context containing:

- the effective `BotProfileConfig`;
- whether the current source/requester is authorized for product functions;
- the current source type;
- whether the requester is an administrator.

An unregistered or blocked requester has no discoverable capability set even if
the base profile has globally enabled functions. `/help` in that state returns
only the existing registration or access guidance.

### Effective Capability Projection

A pure application-owned projector consumes only:

- the already-computed effective access context;
- the canonical function definitions;
- the current LINE source type.

It returns a presentation model:

```ts
interface EffectiveCapabilityProjection {
  reads: CapabilityPresentation[];
  writes: CapabilityPresentation[];
  onboarding: CapabilityPresentation[];
}

interface CapabilityPresentation {
  functionName: FunctionName;
  displayName: string;
  shortDescription: string;
  example: string;
  quickReply: { label: string; text: string };
}
```

`functionName` remains internal and is available for policy checks, tests, and
administrator diagnostics. Ordinary renderers never print it.

The projector:

- selects only functions present in the effective profile;
- rechecks `allowedSources` for the current LINE source;
- groups by `sideEffectLevel`;
- excludes `admin` and `destructive` actions from ordinary presentation;
- ranks onboarding reads by
  `query_schedule`, `find_sheet_music`, `find_ppt_slides`, then canonical
  function-definition order;
- uses the first executable definition example as the Quick Reply text;
- caps onboarding and Quick Replies at three;
- remains deterministic and does not accept a random source;
- returns empty output when the requester is not authorized.

The projector cannot query the database, call a model, modify a profile, or
grant a function.

### Presentation Renderers

Small renderers consume the projection:

- registration-completion renderer;
- public-help renderer;
- natural-language capability-introduction renderer;
- administrator effective-function formatter.

The renderers share the same presentation records and differ only in framing.
They do not independently select or filter capabilities.

Identity introduction remains:

> 我是小哈，家教會的小幫手。

It does not invoke the full capability renderer.

### Registration Data Flow

Registration remains an invite-code command and does not pass through DeepSeek.

After a principal is successfully added:

1. record the existing audit and privacy-safe registration event;
2. recompute effective access from the newly committed principal state;
3. build the projection;
4. render registration completion;
5. return text plus at most three Quick Replies.

Direct registration does not expose the LINE user ID. Group registration does
not expose the LINE group ID. A resolved display name may be used softly, but
the default success copy does not require it.

Example:

```text
已開通，你現在可以使用小哈。

可以先試試：
- 查下一場服事表
- 找詩歌譜
- 找投影片
```

If no read is currently available, the reply honestly states that registration
is complete but no query is currently open. It does not invent examples.

### Help And Capability Introduction

`/help` and natural-language requests such as `你能做什麼` share one
projection and one capability-list renderer.

The list:

- shows all effective reads under `可以查詢`;
- shows all effective writes under `可以保存或更新`;
- omits an empty section;
- uses `displayName` and `shortDescription`;
- exposes no storage, provider, model, source ID, or function name;
- includes at most three preferred Quick Replies.

`/help admin` and `/help admin all` remain separate administrator surfaces.
Administrator status does not cause ordinary `/help` to print admin commands or
internal implementation details.

### Controlled Result Guidance

R4.1 adds a pure copy policy keyed by existing controlled states. It does not
replace capability handlers or the turn state machine.

| State                 | Product copy responsibility                           | Maximum next action                                                      |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `success`             | Preserve the focused capability result                | Offer full result only when the capability contract supports `view_full` |
| missing required slot | Use the definition-owned prompt                       | Ask for the one missing value or show its existing bounded Quick Replies |
| `ambiguous`           | Preserve grounded numbered/postback choices           | Ask the requester to select one                                          |
| `not_found`           | State that no matching result was found               | Ask for a different keyword or narrower condition                        |
| `unavailable`         | State that the capability is temporarily unavailable  | Ask the requester to try later                                           |
| stale-but-allowed     | Return the usable result and its data timestamp       | No automatic retry                                                       |
| permission denied     | State that the current source/requester cannot use it | Offer `/help`                                                            |
| error                 | Return the existing safe failure copy/support path    | No speculative action                                                    |

Rules:

- at most one next action;
- no automatic retry loop;
- no raw error, provider, model, storage, URL, source title, or identifier;
- no handler-specific branch in the generic router or validator;
- capability-owned clarification and selection state remain authoritative;
- stale copy must distinguish usable old data from unavailable data.

### Administrator Group Summary

Existing administrator surfaces are extended:

- `/access-list` includes group display name, active state, effective function
  names, last privacy-safe successful function, and last-success time;
- `/function-scopes` remains the detailed explanation of profile defaults,
  group grants, user grants, and role-derived authority;
- `/catalog-sources` and existing knowledge-source views include owner and
  freshness-responsibility labels.

The group summary does not include requester identity, message text, query,
result content, file name, URL, or secret.

To make last success durable without a new table, the existing group principal
record receives nullable `last_success_function_name` and
`last_success_at` fields. A successful controlled function in a registered
group updates only those two fields after product completion. Failure to update
the summary must not change the function reply.

Catalog source ownership and freshness responsibility are optional DB-owned
metadata on the existing source record. Idempotent seeds may populate a default
label only when creating a missing source; they must not overwrite an
administrator-owned value. Dynamic knowledge views use their existing
creator/lifecycle metadata and a generic responsibility label when no explicit
owner label exists.

No ordinary-user response consumes these administrator fields.

## Privacy-Safe Adoption Events

Reuse the existing product-event pipeline. R4.1 does not add raw analytics.

The implementation must support:

- registration completion;
- first successful function use per source/requester;
- clarification;
- controlled result class;
- write completion;
- retry observation.

The existing HMAC actor fingerprint remains the correlation key. Event payloads
may include only allowlisted event name, source type, function name, result
class, latency bucket, clarification-count bucket, and retry boolean.

To identify first success without raw identity, store only a bounded
source/requester success marker in the existing Redis-backed product state when
Redis is configured; the in-memory equivalent is acceptable locally. The marker
must not contain raw user text or result content. This measurement is
observational and never affects authority or replies.

## Source Isolation

Formal schedules, catalog data, and promoted knowledge remain profile-shared.
Requester workflow state remains scoped by profile, LINE source, and requester.

Synthetic branch-group coverage must prove:

- both registered groups can discover the same authorized shared reads;
- one group can have an additive group grant without changing the other;
- a user grant affects only that requester, including inside a group;
- selections, active tasks, jobs, attachment flows, and explicit group memories
  cannot cross group or requester scope;
- one group registration/help reply never prints the other group's display
  name, authority, or activity.

## Error Handling

- Projection construction is pure and cannot fail on remote dependencies.
- Unknown function names fail closed and are omitted from presentation.
- Missing function-definition metadata is a test/build contract failure, not a
  runtime fallback.
- A post-registration projection failure returns a short registration-success
  reply without examples; registration is not rolled back.
- Observability and last-success summary writes are best-effort and cannot
  change product behavior.
- An unavailable access store follows the existing readiness and access policy;
  the presenter does not fall back to profile-wide authority.
- Quick Reply labels and texts must satisfy LINE length limits in deterministic
  unit tests.

## Testing Strategy

### Pure Projection Tests

Cover:

- deterministic preferred ordering;
- full read/write grouping;
- source-policy filtering;
- unregistered/blocked empty projection;
- admin authority without admin-command leakage;
- no unauthorized write;
- fallback ordering when a preferred read is absent;
- maximum three onboarding actions;
- no implementation terms in ordinary labels or copy.

### Entrance Tests

Cover:

- direct and group registration completion text and Quick Replies;
- no user/group ID in registration completion;
- `/help` for direct user, group requester, granted user, and admin;
- unregistered `/help` gives registration guidance instead of capabilities;
- `/help` and natural-language introduction expose the same effective set;
- identity-only introduction remains short;
- group wake-word and requester isolation remain intact.

### Result-State Tests

Add shared copy-contract tests for permission denied, missing input, ambiguity,
not found, unavailable, stale-but-allowed, success, and error. Existing
capability tests continue to prove grounded selection, focused results, and
requester-scoped continuation.

### Administrator Tests

Cover:

- `/access-list` group summary fields;
- effective function calculation with defaults, grants, roles, and disabled
  principals;
- privacy-safe last success;
- source owner/freshness responsibility visible only to administrators;
- `/last-routes` and product events remain sanitized.

### Kernel Cases

Add versioned deterministic R4.1 cases for:

- registration-to-first-read journey;
- exact effective discovery for direct user, group user, granted user, and
  admin;
- unavailable write never advertised;
- all controlled result classes and bounded next actions;
- two synthetic branch groups with shared data and isolated requester state.

Run the normal offline Kernel gate. Run the real Redis/PostgreSQL integration
gate because R4.1 changes access-principal summary persistence and
requester-scoped first-success state. No live DeepSeek or embedding call is
needed for acceptance.

## Documentation

Update:

- `README.md` for registration completion, `/help`, capability introduction,
  and administrator summaries;
- `docs/architecture-context.md` for effective capability projection and result
  guidance;
- `AGENTS.md` only if the implementation establishes a durable rule not already
  present;
- the R4.1 roadmap status after all exit criteria pass.

## Non-Goals

- no new first-class function;
- no new admin command;
- no SaaS tenant model or per-church deployment system;
- no second profile implementation;
- no new database service or capability-projection table;
- no model-generated help text;
- no general web browsing;
- no automatic group-chat recording;
- no raw product analytics;
- no recruited human acceptance session;
- no LINE push quota for onboarding or job results;
- no change to controlled-router authority.

## Exit Criteria

R4.1 is complete only when:

- registration completion offers two or three currently authorized executable
  read journeys when available;
- `/help`, natural-language capability introduction, and Quick Replies derive
  from the same projection;
- ordinary discovery exactly matches the current effective function set;
- unavailable writes are never advertised;
- every controlled result class has stable Traditional Chinese copy and at most
  one bounded next action;
- administrator group summaries contain display name, active state, effective
  functions, and privacy-safe last success;
- source administration states owner and freshness responsibility;
- synthetic branch groups share formal data and preserve requester-state
  isolation;
- product events remain allowlist-only and contain no raw content;
- required unit, entrance, admin, Kernel, and Kernel integration gates pass.
