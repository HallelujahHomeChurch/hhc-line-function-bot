# Modular Monolith Maintainability Design

## Status

Approved on 2026-07-24. This design defines roadmap milestone R3.5, which
follows final Kernel v1 stabilization and precedes R4 Product Experience.

## Goal

Improve the maintainability of the single deployed TypeScript/Fastify service
without changing its user-facing behavior, controlled-routing authority, or
deployment topology.

## Decision

The service remains a modular monolith. It will use explicit factory-based
dependency injection at the composition root rather than a runtime DI
container. New abstractions are introduced only when a stable consumer-facing
capability has two or more real implementations or needs an external fake for
deterministic tests.

## Architecture

### Dependency direction

`bootstrap` is the sole composition root and may create concrete PostgreSQL,
Redis, Graph, Notion, LINE, and LLM adapters. `transport` converts HTTP/LINE
input to application commands and does not access infrastructure directly.
`application` coordinates use cases and workflow stages through ports.
`capabilities` own product behavior and depend only on their narrow ports and
kernel contracts. `infrastructure` implements those ports.

Automated import rules enforce the direction. They are part of CI, not a
convention documented only in prose.

### Dependency injection

Each capability constructor accepts only the dependencies it uses. The current
large module context is replaced incrementally; it must not be a new service
locator under a different name. Production composition supplies concrete
implementations. Test builders supply explicit fakes or in-memory stores, so
production paths never silently select an in-memory fallback.

No decorator-based container or reflection metadata is introduced. Factories
and TypeScript interfaces keep construction visible and static.

### Module ownership

Capabilities migrate toward vertical slices containing their definition,
handler, ports, and eval cases. Shared kernel code continues to own only stable
rules: capability contracts, authorization/result envelopes, requester scope,
turn-state contracts, and controlled validation. It must not acquire
capability-specific branches.

`query_schedule` is the reference migration because it exercises declarative
domain selection, reads, writes, clarification, result envelopes, and
requester-scoped continuation.

### Transport and turns

Fastify route creation remains in one application, but the existing server is
split into focused adapters for webhook entrance, public/access commands,
admin commands, postbacks, and health/readiness. The controlled turn runtime is
split into stage implementations plus a coordinator. Its stage order and all
security-sensitive precedence rules remain unchanged.

### Type ownership

Global shared types are migrated into bounded modules. A type belongs beside
the domain that owns its invariants; cross-boundary contracts live in kernel or
application ports. There is no global catch-all type file for new behavior.

## Scope boundaries

This milestone permits related naming, import, file-organization, and local
duplicate-code cleanup. It excludes microservices, changes to LINE paths,
profile policy, access policy, controlled routing, result-envelope privacy,
database semantics, and standalone cosmetic rewrites.

## Verification

Each refactoring slice starts with behavior-preserving tests. The completed
milestone must enforce dependency rules in CI, retain full unit/eval coverage,
and pass the versioned Kernel acceptance gate. A reference capability slice
must prove construction with concrete adapters and explicit test fakes.

## Success criteria

- Developers can identify a capability's contract, behavior, dependencies, and
  eval cases from one module boundary.
- Adding a capability does not require expanding a global dependency context.
- Production construction and test construction are explicit and visibly
  different.
- Transport, application orchestration, capability logic, and infrastructure
  have mechanically enforceable dependency direction.
