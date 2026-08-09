# Requirements Document

## Introduction

Cartethyia's `src/` tree has accumulated several multi-responsibility modules. The largest are `storage/main/config.ts` (2,109 lines), `console/services.ts` (1,568), `storage/runtime/runtime.ts` (1,455), `console/api.ts` (933), `open-sse/transport/shared.ts` (822), `console/views.ts` (799), `auth/credentials.ts` (737), `traffic/network.ts` (730), and `bootstrap/composition.ts` (672).

This change restructures source ownership into cohesive folders and modules without changing runtime behavior, database schema, public HTTP contract, or configuration semantics. It is a clean source cutover: every internal import and test import moves to canonical paths; no compatibility re-exports, path shims, duplicate implementations, or deprecated source paths remain.

## Requirements

### Requirement 1 — Cohesive module boundaries

**User Story:** As a maintainer, I want each source module to own one cohesive responsibility so that I can locate, review, and change behavior without navigating unrelated code.

#### Acceptance Criteria

1. WHEN a current source file owns multiple independent responsibilities THEN Cartethyia SHALL split it only along existing domain boundaries, retaining closely related helpers together.
2. WHEN a module is split THEN Cartethyia SHALL keep each new module named for its owned behavior rather than a generic `utils`, `helpers`, `common`, or `misc` category.
3. WHEN the restructuring is complete THEN no targeted implementation module SHALL exceed 500 lines unless a documented protocol codec or provider adapter is intrinsically cohesive at that size.
4. WHEN types are consumed across a domain boundary THEN Cartethyia SHALL place them beside the domain contract they describe, not in a global catch-all type module.

### Requirement 2 — Canonical source topology

**User Story:** As a maintainer, I want folder names to describe architectural ownership so that import paths communicate the role of code.

#### Acceptance Criteria

1. Cartethyia SHALL retain the existing top-level folders: `application/`, `bootstrap/`, `console/`, `middleware/`, `observability/`, `open-sse/`, `providers/`, `security/`, `storage/`, and `traffic/`.
2. Cartethyia SHALL relocate the application authentication lifecycle from `auth/` to `application/auth/` as one clean cutover, because credentials, OAuth sessions, token refresh, and quota refresh are application behavior rather than runtime composition.
3. Cartethyia SHALL use cohesive subfolders and files inside those established roots where the current file's responsibilities warrant a split.
4. Cartethyia SHALL retain `open-sse/`, `bootstrap/`, `middleware/`, and `storage/` as their current top-level names.
5. Cartethyia SHALL retain `providers/`, `traffic/`, `security/`, and `observability/` where their names already accurately describe their responsibility.

### Requirement 3 — Clean cutover

**User Story:** As a maintainer, I want exactly one canonical path for each source symbol so that refactors do not leave long-term compatibility debt.

#### Acceptance Criteria

1. WHEN a module moves THEN every production and test import SHALL move in the same change set.
2. Cartethyia SHALL NOT retain forwarding files, compatibility re-exports, duplicate source modules, or deprecated aliases at the old paths.
3. WHEN an exported symbol moves THEN its implementation, contract, tests, and all statically resolvable importers SHALL use the new canonical path.
4. Cartethyia SHALL preserve the existing process entrypoint and external HTTP/API behavior unless a separate approved requirement explicitly changes them.

### Requirement 4 — Persistence decomposition

**User Story:** As a maintainer, I want configuration and telemetry persistence broken into repositories and lifecycle modules so that SQLite behavior is isolated and auditable.

#### Acceptance Criteria

1. WHEN configuration persistence is restructured THEN Cartethyia SHALL separate database lifecycle, row mapping, repository groups, durable stores, and root persistence composition.
2. WHEN runtime telemetry persistence is restructured THEN Cartethyia SHALL separate database lifecycle, write buffering, request history queries, payload storage, console logs, Warp metrics, retention, and root persistence composition.
3. Cartethyia SHALL preserve existing SQLite table names, schema, query semantics, batching, retention behavior, and test reset behavior.
4. Cartethyia SHALL NOT introduce an ORM, a second database abstraction, or database migration solely for this source restructure.

### Requirement 5 — Admin decomposition

**User Story:** As a maintainer, I want console administration code arranged by admin domain so that routes, services, and views change together without one giant file.

#### Acceptance Criteria

1. WHEN console services are restructured THEN Cartethyia SHALL group services by authentication, API keys, providers/models, accounts/OAuth/quota, proxies, routing, settings/filter rules, telemetry, and backup.
2. WHEN console HTTP routes are restructured THEN Cartethyia SHALL group route registration by the same admin domain and retain one explicit API composition entrypoint.
3. WHEN console view contracts are restructured THEN Cartethyia SHALL group request and response DTOs by admin domain.
4. Cartethyia SHALL preserve route methods, paths, request validation, response bodies, authentication, and status codes.

### Requirement 6 — Gateway and request orchestration decomposition

**User Story:** As a maintainer, I want protocol translation and proxy orchestration separated by lifecycle so that streaming and failure behavior remain understandable.

#### Acceptance Criteria

1. WHEN gateway transport is restructured THEN Cartethyia SHALL separate provider error mapping, abort coordination, bounded body reads, fetch execution, SSE decoding, stream mapping, model catalog helpers, and OpenAI-compatible adapter construction.
2. WHEN proxy request orchestration is restructured THEN Cartethyia SHALL separate request preparation, payload capture, telemetry projection, route attempt execution, and top-level request lifecycle.
3. Cartethyia SHALL preserve streaming ownership, abort propagation, retry/failover policy, telemetry records, payload capture behavior, and error translation.

### Requirement 7 — Controlled delivery and verification

**User Story:** As a maintainer, I want the restructure delivered in reviewable slices so that structural changes do not hide behavioral regressions.

#### Acceptance Criteria

1. WHEN a slice changes exported symbols THEN Cartethyia SHALL use symbol-aware references to migrate all importers before deleting the original module.
2. WHEN a slice is complete THEN Cartethyia SHALL run the targeted contract tests for that domain and TypeScript validation before the next slice.
3. WHEN the full restructure is complete THEN Cartethyia SHALL pass the backend test suite, dashboard test suite, backend typecheck, dashboard build, and native backend build.
4. Cartethyia SHALL keep each commit bounded to one architectural slice with no unrelated behavior change.

### Requirement 8 — Repository-wide naming and construction contract

**User Story:** As a maintainer, I want every symbol in `src/**` to state its domain role, action, and lifetime consistently, so that any source file is understandable without relying on ambiguous local conventions.

#### Acceptance Criteria

1. Cartethyia SHALL apply this contract to every production TypeScript symbol in `src/**`: files, directories, exports, local functions, classes, interfaces, types, values, parameters, callbacks, and database/HTTP boundary fields.
2. WHEN a function constructs an object, stateful closure, sub-application, repository, adapter, stream mapper, or fetcher THEN it SHALL use `create<SpecificNoun>`. `make*` is prohibited.
3. WHEN a function mounts routes into an existing Elysia application THEN it SHALL use `register<Domain>Routes`; `create<Domain>Api` is reserved for constructing and returning an independently mountable sub-application.
4. WHEN a function processes one request, callback, event, stream, or queued job THEN it SHALL use `handle<SpecificAction>`; bare `Handler` names are prohibited.
5. WHEN a function returns a newly derived value without I/O THEN it SHALL use the precise value verb: `build`, `calculate`, `format`, `parse`, `decode`, `encode`, `map`, `normalize`, `sanitize`, `resolve`, `select`, `extract`, `classify`, or `to`. Generic `process`, `data`, `util`, `helper`, and `common` names are prohibited.
6. WHEN a function performs I/O or changes state THEN its verb SHALL expose the effect: `get`, `list`, `query`, `read`, `write`, `insert`, `update`, `delete`, `clear`, `restore`, `start`, `stop`, `close`, `schedule`, `cancel`, `acquire`, `release`, `record`, `register`, or `unregister`.
7. WHEN a function returns a boolean predicate THEN it SHALL start with `is`, `has`, `can`, `should`, `needs`, or `requires`; WHEN it throws to enforce an invariant THEN it SHALL start with `assert` or `ensure`.
8. Cartethyia SHALL use role-specific type suffixes (`Config`, `Options`, `Input`, `Result`, `Record`, `View`, `Snapshot`, `Policy`, `Repository`, `Store`, `Service`, `Adapter`, `Driver`, `Registry`, `Manager`, `Worker`, `Controller`, `Coordinator`, `Pool`, `Cache`, `Collector`, and `Error`) according to the ownership rules in the design.
9. WHEN a dependency is long-lived THEN its direct composition owner SHALL construct it once and pass it to consumers; route registration and request handling SHALL NOT create duplicate services, workers, repositories, or sub-applications. Per-request stateful mappers/controllers remain newly constructed for each request or stream.
10. WHEN a structural slice changes a symbol, all introduced names and all renamed symbols in that slice SHALL comply with this contract. It SHALL use LSP references to migrate every importer and remove the prior name in the same clean-cutover commit.
11. Cartethyia SHALL preserve third-party wire field names only at the adapter/codec boundary; normalized internal names SHALL follow this contract.
