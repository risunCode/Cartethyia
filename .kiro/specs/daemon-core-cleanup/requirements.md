# Requirements Document

## Introduction

This specification defines the conservative cleanup of the Cartethyia daemon before the next reinforcement and hardening pass.

The cleanup SHALL optimize real ownership and request-path duplication without treating Go file length as a defect. Files between 800 and 1200 lines MAY remain when they represent one coherent state machine, protocol surface, catalog, migration registry, or provider definition group.

The current daemon contains approximately 60 Go packages, 321 non-test Go files, duplicated proxy package authority, fragmented public API packages, fragmented account-driver packages, and request-path areas where stream/non-stream attempt orchestration may duplicate work. The cleanup SHALL preserve all functional surfaces and SHALL only claim runtime improvements that are supported by benchmark, allocation, contention, or profile evidence.

### Scope

In scope:

- daemon package and ownership cleanup;
- proxy alias-authority removal after caller migration;
- public API package consolidation without wire-contract changes;
- account-driver package consolidation without auth behavior changes;
- measured deduplication of router attempt orchestration;
- measured stream-frame allocation optimization;
- measured cache and protocol conversion optimization;
- import-direction and dependency-fan-out cleanup;
- full functional and compatibility verification.

Out of scope for the first cleanup phase:

- removing providers, endpoints, account modes, protocol surfaces, cache backends, admin routes, or persistence features;
- replacing protocol-specific codecs with one generic wire switch;
- flattening valid database, provider, transport, catalog, cache, security, or lifecycle boundaries only to reduce package count;
- moving every persistence model into a new domain package before request-path cleanup is stable;
- adding new provider functionality or new compatibility behavior;
- claiming performance gains without measured evidence.

## Requirements

### Requirement 1: Preserve all production functionality

**User Story:** As a daemon maintainer, I want cleanup changes to preserve every real daemon capability, so that structural refactoring cannot silently remove supported behavior.

#### Acceptance Criteria

1. WHEN the cleanup is applied THEN the system SHALL retain OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, tool calls/results, media/document/PDF handling, reasoning, compaction, context management, compatibility planning, and response projection.
2. WHEN the cleanup is applied THEN the system SHALL retain account selection, per-model locks, cooldowns, readiness, OAuth refresh, late credential resolution, compatibility repair, retry, refresh, failover, hedging, quota reservation, stream preflight, stream finalization, and cancellation cleanup.
3. WHEN the cleanup is applied THEN the system SHALL retain memory cache, Redis cache, fallback policy, response cache, content cache, generation invalidation, miss coalescing, provider catalog refresh, custom providers, admin routes, public routes, CLI commands, backup/restore, telemetry, usage accounting, security capture prevention, and bounded observability.
4. IF an exported symbol or package path is moved THEN all production callers and relevant tests SHALL be migrated before the old authority is deleted.
5. WHEN a cleanup slice is complete THEN the compatibility corpus SHALL continue to pass 19/19 scenarios and 15/15 Tier-0 scenarios at 10000 basis points for both total and Tier-0 scores.

### Requirement 2: Use ownership boundaries based on behavior

**User Story:** As a maintainer, I want each package boundary to represent an actual lifecycle or dependency direction, so that the tree remains understandable without unnecessary micro-packages.

#### Acceptance Criteria

1. The system SHALL retain separate ownership for application composition, accounts, account drivers, configuration, database persistence, database backup, database migrations, observability, usage, providers, provider adapters, proxy runtime, proxy catalog, proxy protocol, compatibility corpus, outbound transport, cache, security capture, security outbound policy, HTTP server, public API, admin API, and middleware where those boundaries have independent lifecycles or dependency directions.
2. The system SHALL NOT split a file solely because it exceeds an arbitrary LOC threshold.
3. The system SHALL NOT merge protocol surfaces, cache backends, catalog and router state, transport and retry policy, public and admin APIs, or account domain and provider driver implementations solely to reduce file or package count.
4. IF a package is flattened THEN the resulting package SHALL not introduce a dependency cycle or make a previously narrow dependency import a concrete higher-level subsystem.
5. The proposed package tree SHALL remain conservative, with an expected reduction from approximately 60 packages toward approximately 40–42 packages rather than a hard requirement to reach a fixed count.

### Requirement 3: Remove duplicate proxy authority

**User Story:** As a proxy maintainer, I want one authoritative proxy implementation path, so that aliases do not hide the actual dependency graph or create competing ownership.

#### Acceptance Criteria

1. WHEN all internal callers have migrated THEN the system SHALL use `internal/proxy/runtime` as the sole proxy implementation authority.
2. IF `internal/proxy/proxy.go` has zero production references THEN the compatibility alias façade SHALL be deleted rather than retained as a permanent duplicate authority.
3. WHEN the proxy authority is migrated THEN `Router`, `DispatchService`, `Stream`, `Transport`, account runtime types, and related exported symbols SHALL retain equivalent behavior and type contracts for all remaining callers.
4. The migration SHALL NOT delete or bypass router, stream, transport, cache, protocol, or observability behavior.

### Requirement 4: Consolidate public API orchestration without changing wire semantics

**User Story:** As an HTTP API maintainer, I want the public generation endpoints to share one request lifecycle owner, so that fixes to decode, planning, dispatch, error mapping, and streaming are not duplicated across tiny packages.

#### Acceptance Criteria

1. WHEN the public API consolidation is complete THEN the public endpoint handlers SHALL have one `server/api` ownership boundary for shared HTTP orchestration.
2. The system SHALL retain distinct handler behavior for Chat Completions, Messages, Gemini Generate Content, Responses, Images, Models, and Actions.
3. The shared API lifecycle SHALL cover request extraction, context/deadline handling, codec selection, compatibility planning, dispatch invocation, normal response projection, stream writing, and error mapping without forwarding raw provider responses.
4. WHEN API packages are flattened THEN OpenAI, Anthropic, and Gemini wire shapes, event names, tool semantics, media envelopes, reasoning fields, finish semantics, and terminal behavior SHALL remain surface-specific.
5. The API migration SHALL preserve public route paths, status codes, response headers, streaming content types, capability errors, and client-visible error contracts unless an existing contract test explicitly requires a correction.

### Requirement 5: Consolidate account-driver package scaffolding

**User Story:** As an account maintainer, I want driver implementations to share one driver package while remaining separate implementations, so that package scaffolding does not obscure the registry boundary.

#### Acceptance Criteria

1. WHEN account-driver consolidation is complete THEN the concrete Anthropic, Antigravity, Cline, Codex, Grokbuild, Kimchi, and Kiro drivers SHALL remain independently identifiable and registered.
2. The consolidation SHALL remove only unnecessary nested package boundaries and SHALL NOT remove credential modes, refresh flows, token parsing, provider-specific endpoints, or driver-specific error handling.
3. Shared driver helpers SHALL have one owner in the driver package and SHALL not be duplicated across provider drivers.
4. Account references, secret zeroing, OAuth refresh coordination, credential invalidation, and readiness behavior SHALL remain unchanged.

### Requirement 6: Deduplicate router attempt orchestration safely

**User Story:** As a routing maintainer, I want stream and non-stream routes to share only identical attempt bookkeeping, so that retry policy cannot diverge while stream terminal ownership remains explicit.

#### Acceptance Criteria

1. The cleanup SHALL identify and compare duplicated candidate acquisition, preparation, reservation, attempt bookkeeping, failure classification, refresh, availability, and retry transitions between `Route` and `RouteStream`.
2. WHEN two transitions are behaviorally identical THEN the implementation MAY share bounded internal state or helpers for those transitions.
3. The implementation SHALL keep non-stream response acceptance, stream preflight, stream terminal ownership, stream cancellation, and stream finalization semantics explicit.
4. The router SHALL preserve bounded maximum attempts, refresh budget, repair budget, hedge budget, account exclusions, per-model failure scope, quota reservation reconciliation, and evidence emission.
5. A routing deduplication change SHALL demonstrate no additional provider call on ordinary success and no change to retry, refresh, failover, repair, hedge, or exhaustion outcomes.

### Requirement 7: Optimize measured hot paths

**User Story:** As an operator, I want performance work to target measured cost rather than source-file aesthetics, so that cleanup produces real runtime value.

#### Acceptance Criteria

1. BEFORE changing router, stream, cache, or protocol hot paths, the project SHALL record representative benchmark and allocation baselines.
2. IF stream frame allocation is a measured hotspot THEN the implementation MAY use typed frame values, bounded scratch buffers, or direct encoding while preserving wire behavior and concurrency ownership.
3. IF protocol conversion or defensive copying is a measured hotspot THEN the implementation MAY reduce repeated conversion only after an explicit ownership rule proves that aliasing, mutation, and cross-goroutine safety remain intact.
4. IF cache key/value construction is a measured hotspot THEN the implementation MAY optimize hashing, serialization, or copies while preserving tenant, policy, generation, credential-safety, and false-reuse invariants.
5. A claimed latency, allocation, lock, cache, stream, or protocol improvement SHALL include the corresponding benchmark, allocation profile, mutex/block profile, or behavioral evidence.
6. Splitting or merging files without changing package calls, allocations, lock behavior, or data flow SHALL NOT be reported as a runtime performance improvement.

### Requirement 8: Preserve cache and concurrency invariants

**User Story:** As a reliability maintainer, I want cache cleanup to preserve single-flight and close behavior, so that deduplication cannot reintroduce races or thundering-herd behavior.

#### Acceptance Criteria

1. The memory cache SHALL continue to enforce bounded LRU entries, bounded in-flight keys, one loader per coalesced key, and defensive value ownership.
2. WHEN a cache is closed THEN all in-flight waiters SHALL wake with the typed closed error and no leader SHALL write to a flight after close publication.
3. The Redis/router cache SHALL retain health state, fallback policy, generation invalidation, remote error classification, and fail-closed behavior.
4. A response-cache hit SHALL perform zero provider calls and SHALL not bypass tenant, policy-generation, content, or credential safety boundaries.
5. Cache cleanup SHALL pass race, fuzz, benchmark, and concurrent load proof relevant to the changed backend.

### Requirement 9: Keep import direction efficient

**User Story:** As a maintainer, I want imports to reflect ownership rather than hide dependencies, so that build invalidation and future changes remain bounded.

#### Acceptance Criteria

1. The composition root SHALL be allowed to import concrete accounts, database, providers, cache, transport, server, observability, security, and proxy implementations.
2. Request-path proxy packages SHALL NOT import the application composition root or concrete HTTP server handlers.
3. Canonical protocol model/transform packages SHALL NOT import database repositories, HTTP server handlers, or provider HTTP implementations.
4. Database persistence packages SHALL NOT become a dependency of protocol codecs or router policy.
5. The cleanup SHALL remove unnecessary aliases, wrappers, and duplicate package paths without replacing them with hidden factories that preserve the same dependency graph.
6. After each migration, package listing and import analysis SHALL confirm that no dependency cycle or unintended higher-level import was introduced.

### Requirement 10: Keep valid persistence and provider boundaries stable

**User Story:** As a maintainer, I want risky domain migrations deferred until request-path cleanup is stable, so that structural cleanup does not become an uncontrolled persistence rewrite.

#### Acceptance Criteria

1. The first cleanup phase SHALL retain database models, repositories, migrations, backup/restore, token budget persistence, and telemetry persistence.
2. The first cleanup phase SHALL retain provider definitions, adapters, builtin providers, OAuth providers, API-key providers, and provider policies.
3. IF a later phase moves a persistence model into an account, provider, or network domain THEN all repository mapping and callers SHALL be migrated together and the old model authority SHALL be removed only after reference verification.
4. No provider or persistence feature SHALL be removed solely to reduce package or file count.

### Requirement 11: Verify every cleanup slice end to end

**User Story:** As a release maintainer, I want each cleanup slice verified against behavior and performance contracts, so that package migration does not hide regressions.

#### Acceptance Criteria

1. Each bounded cleanup slice SHALL pass normal tests, build, and vet before it is marked complete.
2. Each cleanup slice touching concurrency, cache, routing, stream, transport, or protocol SHALL pass the applicable race suite.
3. The full daemon SHALL pass the compatibility acceptance command with the existing 19/19 and 15/15 baseline.
4. Routing verification SHALL cover ordinary success, retry, refresh, failover, exhaustion, hedge eligibility, repair, stream preflight failure, cancellation, and terminal finalization.
5. Protocol verification SHALL cover source/target differential behavior, tool occurrence pairing, media/document/PDF semantics, reasoning, compaction, cache safety, and strict response projection.
6. Performance claims SHALL identify their baseline, workload, metric, and observed result; unmeasured structural changes SHALL be reported as maintainability/build changes only.

## Non-functional constraints

- No intentional feature deletion.
- No raw credential, prompt, tool content, cache digest, or secret in new observability labels.
- No raw provider response bypass in strict projection.
- No unbounded labels, maps, buffers, retries, hedges, or cache flights.
- No compatibility alias retained after its migration references reach zero.
- No source tree target is accepted solely because it has fewer files.
