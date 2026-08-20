# Cartethyia Proxy Router
## Master Implementation Plan: Multi-Agent Refactor and End-to-End Verification

**Status:** execution-ready plan

**Architecture authority:** `PROXY_ROUTER_MASTER_RESTRUCTURE_REPORT.md`

**Execution model:** Main foundation work, then waves of at most five subagents, mandatory verification barrier after every wave, final independent audit, final end-to-end proof by Main.

---

# 1. Objective

Execute the approved restructure without creating duplicate authorities, compatibility wrappers, abandoned packages, or parallel router implementations.

Final result:

```text
Cartethyia/
├── router/       Go Proxy Router runtime
├── dashboard/    SolidJS operator dashboard
├── contracts/    public and console wire contracts plus compatibility fixtures
├── tests/        cross-process contract, integration, load, performance, and smoke proof
├── deploy/       Docker and deployment assets
├── tools/        repository development and verification tools
├── docs/         architecture, operations, and deployment documentation
└── vendor/       vendored third-party dependencies
```

Runtime authority:

```text
Client
  |
  v
Gateway -> Protocol decision -> Router -> Provider/Account -> Egress -> Upstream
             |                  |
             |                  +-> retry, failover, cache, batch
             |
             +-> PASS | PATCH | TRANSLATE

Dashboard -> Console API -> Router services and telemetry projections
```

---

# 2. Non-Negotiable Execution Rules

## 2.1 Agent limit

- Maximum five subagents running concurrently.
- One wave is one `tasks[]` delegation batch.
- Main does not delegate the next wave until every task in the current wave has settled and the wave verification gate passes.
- A wave may use fewer than five agents when package dependencies make additional concurrency unsafe.
- Failed verification does not advance the wave counter.
- Repair work is assigned as a repair wave with at most five agents, then the same gate is rerun.

## 2.2 Agent work contract

Every delegated task must contain:

```text
# Target
Exact files, directories, symbols, ownership boundary, and explicit non-goals.

# Change
Complete move/refactor/cutover behavior, final import paths, shared interfaces, and cleanup requirements.

# Acceptance
Observable source result and focused checks Main will run after the wave.
```

Every agent must also receive these constraints:

- do not run formatters, linters, builds, or project-wide tests;
- do not commit;
- do not create wrappers, deprecated aliases, forwarding packages, or duplicate implementations;
- migrate all callers inside the assigned owner;
- delete obsolete source owned by the task after callers are migrated;
- preserve behavior unless the task explicitly owns a behavior cutoff;
- no generic `utils`, `helpers`, `common`, `shared`, `core`, or `services` Go package;
- never log or expose plaintext credentials, cookies, authorization headers, prompts, or full request bodies;
- notify Main about unexpected changes outside the assigned owner instead of reverting them;
- finish the assigned owner end to end; no scaffold, placeholder, mock fallback, or unfinished path.

## 2.3 Main ownership

Main owns all cross-wave integration decisions:

- wave sequencing and dependency barriers;
- shared contract design before agents consume it;
- `go.work`, root `Makefile`, and root `package.json` after the root-cutover wave;
- common protocol decision types;
- common router execution types;
- OpenAPI authority files;
- generated dashboard wire contracts;
- merge-conflict resolution;
- verification commands;
- behavioral smoke tests;
- browser verification;
- final end-to-end proof.

## 2.4 Clean cutover

A move is complete only when:

1. all callers use the final path;
2. tests use the final path;
3. deployment and tools use the final path;
4. the old path is deleted;
5. no alias or wrapper remains;
6. source comments and docs no longer name the old owner;
7. targeted verification passes.

---

# 3. Shared Contracts Locked Before Delegation

Main must publish these contracts in the relevant source package before the wave that consumes them. Agents may implement against them but must not redefine them.

## 3.1 Protocol contracts

```go
type ProcessingMode uint8

const (
    ModePass ProcessingMode = iota
    ModePatch
    ModeTranslate
    ModeReject
)

type CompatibilityDecision struct {
    Mode             ProcessingMode
    SourceSurface    Surface
    TargetSurface    Surface
    SourceStream     bool
    TargetStream     bool
    ModelPatch       string
    RequiredRepairs  RepairSet
    Unsupported      FeatureSet
    Lossy            FeatureSet
    CatalogGeneration uint64
    CapabilityVersion uint64
}
```

Contract rules:

- immutable after route planning;
- no secret or request body;
- cache key includes every field affecting wire behavior;
- `ModePass` cannot contain repair or model patch work;
- `ModePatch` cannot require canonical semantic translation;
- `ModeReject` reaches no account or network acquisition.

## 3.2 Router contracts

```go
type RoutePlan struct {
    RequestID         string
    Members           []RouteMember
    Strategy          Strategy
    RouteBudget       int
    PerMemberBudget   int
    RefreshBudget     int
    RepairBudget      int
    CatalogGeneration uint64
}

type AttemptContext struct {
    Route             RoutePlan
    Member            RouteMember
    Account           AccountLease
    Network           NetworkLease
    Prepared          PreparedAttempt
    Number            int
}

type AttemptOutcome struct {
    Kind               OutcomeKind
    StatusCode         int
    RetryScope         RetryScope
    RetryAfter         time.Time
    ClientCommitted    bool
    Usage              Usage
    SanitizedReason    string
}
```

Contract rules:

- immutable plan;
- one coordinator owns attempt progression;
- exactly one terminal outcome per attempt;
- retry forbidden after client-visible bytes unless an explicit continuation contract allows it;
- provider adapters return classification facts, not global retry decisions.

## 3.3 Batch contracts

```go
type BatchKey struct {
    ProviderID         string
    CapabilityVersion  uint64
    Model               string
    Surface             protocol.Surface
    Endpoint            string
    AccountScope        string
    NetworkID           string
    ResponseMode        string
    ToolSchemaDigest    string
    PolicyDigest        string
    CatalogGeneration   uint64
    TranslationDigest   string
}

type BatchJob struct {
    ID          string
    State       BatchState
    CreatedAt   time.Time
    ExpiresAt   time.Time
    ItemCount   int
}

type BatchItem struct {
    ID          string
    JobID       string
    Position    int
    RequestID   string
    State       BatchItemState
}
```

Contract rules:

- account and tenant security scope are part of grouping;
- stable item ID maps every result;
- each item is classified independently;
- queue, bytes, tokens, workers, and wait are bounded;
- interactive streaming bypasses automatic batch wait.

## 3.4 Console contracts

- Go `router/internal/console/contracts` owns bounded wire models.
- `contracts/openapi/console.yaml` owns the externally checked schema.
- `dashboard/src/api/contracts.ts` is generated or checked from the OpenAPI contract.
- database models never cross the console API.
- no field carrying secrets, full prompts, full bodies, cookies, or authorization headers is included.

---

# 4. Conflict Avoidance Map

| Shared area | Exclusive editor |
|---|---|
| `go.work`, root `Makefile` | Main, except Wave 1 Agent RootRouterMove |
| root `package.json` | Main, except Wave 1 Agent ToolingMove |
| protocol common contracts | Main foundation |
| codec surface files | assigned surface agent only |
| router common plan/attempt/outcome types | Main foundation |
| `router/internal/app/bootstrap.go` | AppBootstrap agent, then Main |
| provider registry | ProviderRegistry agent |
| account auth registry | AccountAuth agent |
| OpenAPI files | Main, except explicitly assigned console-contract agent |
| dashboard generated contracts | Main |
| dashboard router and API client | Main dashboard foundation |
| deployment Compose/Dockerfile | DeployCutover agent only |
| README and changelog | DocumentationCutover agent only in final cleanup wave |

Subagents may update callers outside their primary directory only when the move requires it. They must not redesign another owner.

---

# 5. Verification Barrier Protocol

After every wave, Main performs this sequence:

```text
1. Collect all agent results.
2. Read claimed changed files and inspect unresolved conflicts.
3. Reconcile shared interfaces and imports.
4. Run focused formatting once for changed Go/TS files.
5. Run focused package tests for affected owners.
6. Run build/typecheck for affected binaries.
7. Run the wave-specific behavioral scenario.
8. Check old paths, aliases, and dead callers are absent.
9. Mark wave accepted only when every gate is green.
10. Delegate the next wave.
```

If a gate fails:

```text
verification failure
       |
       v
Main classifies ownership
       |
       +--> small integration issue: Main fixes and reruns gate
       |
       +--> owner-local issue: repair wave, maximum five agents
       |
       +--> contract flaw: Main repairs shared contract, wakes affected agents
       v
same wave gate reruns
       |
       v
next wave only after green
```

No wave is accepted based only on agent claims.

---

# 6. Foundation 0 — Main Only

## Goal

Create reliable baselines and lock execution contracts before concurrent edits.

## Main actions

1. Capture current Go build and test status.
2. Capture dashboard `test:ci` status.
3. Capture full-stack validation status.
4. Capture current Docker Compose configuration status.
5. Record baseline protocol fixtures for same-surface and cross-surface traffic.
6. Record router retry/failover scenarios.
7. Add hot-path benchmark inputs for request preparation and streaming frames.
8. Record current package import graph and broad exported-symbol blast radius.
9. Freeze the shared contracts listed in Section 3.
10. Record any pre-existing failures separately; do not misattribute them to a wave.

## Baseline commands

```text
cd daemon && go build ./...
cd daemon && go test ./...
cd dashboard && bun run test:ci
bun run scripts/validate-fullstack.ts
docker compose config
```

## Foundation gate F0

- baseline results stored in the execution log;
- compatibility fixtures cover OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, streaming, tool calls, images, and errors where currently supported;
- route scenarios cover success, quota failover, transient failure, permanent failure, refresh retry, cancellation, and stream terminal behavior;
- benchmark commands run successfully;
- shared contracts have one owner.

**Cumulative completion target:** 3%.

---

# 7. Wave 1 — Root Cutover

**Concurrency:** five agents.

**Shared final contract:** `daemon` becomes `router`; `scripts` becomes `tools`; deployment assets live under `deploy`; compatibility fixtures live under `contracts`; cross-process tests live under root `tests`.

## Agent RootRouterMove

### Target

- `daemon/` to `router/`
- `go.work`
- `go.work.sum` only if toolchain changes it
- root `Makefile`
- Go module path references that encode the old filesystem path

### Change

- rename the Go application root cleanly;
- update workspace, build, run, and development commands;
- preserve Go module identity unless module-path change is separately required by source;
- update owned references from `daemon` terminology to `router` where they describe the product folder;
- do not touch Docker or root JavaScript tooling.

### Acceptance

- `router/go.mod` is the active module;
- `daemon/` does not exist;
- Make targets use `router` naming and paths;
- no compatibility symlink or wrapper directory exists.

## Agent ToolingMove

### Target

- root `scripts/`
- `daemon/scripts/` after root rename contract, resolved as `router/scripts/`
- root `package.json`

### Change

- merge repository scripts into root `tools/`;
- keep Go code generators that must run inside the module under `router/scripts/` only when Go package execution requires it;
- update root Bun and Windows commands;
- rename commands from daemon terminology to router terminology;
- do not change runtime behavior.

### Acceptance

- root development commands resolve through `tools/`;
- no duplicate script with the same function remains;
- old root `scripts/` path is absent.

## Agent ContractFixtureMove

### Target

- `daemon/testdata/compatibility`
- compatibility corpus under protocol
- new root `contracts/fixtures`
- fixture callers in Go tests

### Change

- move reusable wire fixtures into `contracts/fixtures` grouped by surface;
- preserve fixture bytes;
- add a manifest with fixture identity, source surface, target surface, stream flag, and expected comparison mode;
- update Go fixture loading paths;
- keep test-only private fixtures beside tests when they are not cross-boundary contracts.

### Acceptance

- one reusable compatibility corpus exists;
- fixture manifest has no unresolved entries;
- old reusable corpus directories are removed.

## Agent CrossProcessTestMove

### Target

- `daemon/test/load`
- new root `tests/contract`, `tests/integration`, `tests/load`, `tests/performance`, `tests/scenarios`, `tests/smoke`
- root test runner references

### Change

- move only black-box or cross-process tests to root `tests`;
- leave package unit tests beside Go source;
- establish scenario naming and invocation convention;
- do not create empty test files or fake scenarios.

### Acceptance

- load tests run from root final path;
- package tests remain local;
- no duplicate test is left in the old path.

## Agent DeployLayoutMove

### Target

- root `Dockerfile`
- root `docker-compose.yml`
- root `docker-entrypoint.sh`
- root `railway.toml`
- `docker/`
- new `deploy/docker` and `deploy/railway`

### Change

- move deployment files to the approved tree;
- update paths for final `router/` and `tools/` roots;
- preserve current runtime, dashboard, and dashboard-audit behavior during this wave;
- keep runtime non-root, health checks, read-only filesystem, and security options;
- do not remove dashboard-audit yet.

### Acceptance

- one Dockerfile and one Compose authority exist under `deploy/docker`;
- Railway configuration lives under `deploy/railway`;
- old root deployment files and `docker/` directory are absent.

## Wave 1 gate G1

```text
cd router && go build ./...
cd router && go test ./...
cd dashboard && bun run test:ci
bun run tools/validate-fullstack.ts
docker compose -f deploy/docker/compose.yaml config
```

Additional checks:

- zero filesystem or textual runtime references to `daemon/`;
- zero root `scripts/` or `docker/` directory;
- fixture manifest resolves every moved fixture;
- Make and root package commands point to existing files.

**Cumulative completion target:** 10%.

---

# 8. Wave 2 — Leaf Go Owners

**Concurrency:** five agents.

**Shared final import roots:**

```text
router/internal/storage
router/internal/telemetry
router/internal/protocol
router/internal/providers
router/internal/accounts
```

## Agent StorageOwner

### Target

- current database package
- final `router/internal/storage`
- all storage models, repositories, migrations, and direct callers

### Change

- rename database owner to storage;
- keep migrations deterministic and ordered;
- keep repository behavior unchanged;
- update all imports and tests;
- do not expose storage models through console or gateway contracts.

### Acceptance

- one storage owner exists;
- migration count and order are unchanged;
- old database package is deleted;
- all direct SQL remains inside storage.

## Agent TelemetryOwner

### Target

- current observability package
- security capture package
- final `router/internal/telemetry`

### Change

- rename observability to telemetry;
- move capture/redaction under telemetry;
- preserve metrics, event, evidence, metadata, and usage behavior;
- update callers and tests;
- retain bounded and content-free telemetry invariants.

### Acceptance

- one telemetry owner exists;
- old observability and capture packages are deleted;
- redaction tests remain behaviorally equivalent.

## Agent ProtocolOwner

### Target

- current proxy protocol contracts, compatibility, transforms, healing, and JSON clone packages
- final `router/internal/protocol` and `router/internal/protocol/codec`

### Change

- perform behavior-neutral package movement first;
- flatten contracts and compatibility into protocol ownership;
- rename transforms to codec;
- move generic repair rules to protocol;
- retain provider-specific repair code temporarily with explicit markers in the provider owner, not as duplicate behavior;
- remove generic JSON clone when callers use immutable or owner-specific copies.

### Acceptance

- all current protocol tests compile from final packages;
- no old proxy/protocol directory remains;
- behavior is unchanged in this wave.

## Agent ProviderOwner

### Target

- current providers package, builtins, API-key definitions, policies, and adapters
- final `router/internal/providers`

### Change

- establish registry, catalog, capability, policy, classification, builtin, and adapters ownership;
- keep provider identity stable;
- merge API-key static definitions into builtin ownership;
- do not move OAuth driver behavior yet; expose only provider auth requirements needed by accounts;
- update callers and tests.

### Acceptance

- one provider registry exists;
- provider IDs and model catalog output are unchanged;
- old provider subpackages are removed when merged.

## Agent AccountOwner

### Target

- current accounts package, flow, drivers
- provider OAuth driver descriptors assigned to account auth
- final `router/internal/accounts`

### Change

- establish credentials, secret storage interface, refresh, health, quota, cooldown, flow, and auth ownership;
- merge provider-specific auth drivers under `accounts/auth`;
- preserve token refresh coalescing and secret handling;
- update callers and tests;
- do not make route selection decisions.

### Acceptance

- one account authority exists;
- one auth registry exists;
- old driver/OAuth packages are deleted;
- plaintext credentials never enter telemetry or console contracts.

## Wave 2 gate G2

```text
cd router && go test ./internal/storage/... ./internal/telemetry/... ./internal/protocol/... ./internal/providers/... ./internal/accounts/...
cd router && go test ./...
cd router && go build ./...
```

Additional checks:

- migration order unchanged;
- provider registry snapshot unchanged;
- OAuth refresh and secret tests pass;
- compatibility corpus passes without intentional output changes;
- old leaf package paths absent.

**Cumulative completion target:** 22%.

---

# 9. Wave 3 — Runtime Owners

**Concurrency:** five agents.

**Final owners:** `egress`, `gateway`, `router`, `console`, and `app`.

## Agent EgressOwner

### Target

- current proxy transport
- security outbound policy
- runtime network/proxy construction
- final `router/internal/egress`

### Change

- unify outbound HTTP, SSE, network proxy, connection reuse, compression, and outbound security policy;
- preserve request cancellation and response-body ownership;
- keep account selection outside egress;
- update callers and tests;
- expose a narrow transport interface consumed by router.

### Acceptance

- one outbound transport owner exists;
- SSRF/outbound policy remains enforced;
- old transport and outbound security packages are deleted.

## Agent GatewayOwner

### Target

- current public API server, API errors, middleware, and public model routes
- final `router/internal/gateway`

### Change

- unify inbound HTTP and middleware ownership;
- preserve OpenAI, Anthropic, Gemini, image, health, and model route behavior;
- map gateway requests into protocol/router contracts;
- keep retry, provider choice, and SQL outside gateway;
- update callers and tests.

### Acceptance

- public ingress routes are owned by gateway;
- one middleware chain exists;
- old server/api, apierrors, and middleware packages are deleted.

## Agent RouterOwner

### Target

- current proxy runtime
- control admission, continuation, token budget
- runtime cache
- proxy compression behavior assigned to router optimizer
- final `router/internal/router`

### Change

- move the complete route runtime without behavior change;
- keep one `Router`/service authority;
- move catalog and cache as router sub-owners;
- flatten admission, continuation, token budget, and optimizer into router ownership where approved;
- update callers and tests;
- do not perform PASS/PATCH optimization yet.

### Acceptance

- one router runtime exists;
- route budgets and failure classification behavior remain unchanged;
- old proxy/runtime, proxy/control, proxy/compression, and runtime/cache paths are removed.

## Agent ConsoleOwner

### Target

- current server/admin
- runtime admin services
- share routes
- session/auth routes
- final `router/internal/console/api`, `console/services`, and `console/contracts`

### Change

- move operator endpoints and services under console ownership;
- preserve route paths and response shapes during this wave;
- separate bounded wire contracts from storage models;
- keep SQL access behind owner services/repositories;
- update tests and callers.

### Acceptance

- one console API owner exists;
- current dashboard routes remain compatible;
- old server/admin and runtime admin files are removed.

## Agent AppBootstrap

### Target

- current runtime composition, config, lifecycle, recovery, diagnostics, command startup
- final `router/internal/app` and `router/cmd/cartethyia`

### Change

- compose final storage, telemetry, protocol, providers, accounts, egress, router, gateway, and console owners;
- keep startup/shutdown/readiness behavior;
- decompose command actions into serve, migrate, config, and probe only where behavior already exists;
- do not create commands with no implementation;
- delete old runtime/config composition files after migration.

### Acceptance

- one bootstrap path starts the router;
- shutdown drains owned background workers;
- readiness reflects dependencies;
- old runtime composition package is deleted.

## Wave 3 gate G3

```text
cd router && go test ./...
cd router && go test -race ./internal/router/... ./internal/accounts/... ./internal/egress/...
cd router && go build ./cmd/cartethyia
cd dashboard && bun run test:ci
bun run tools/validate-fullstack.ts
```

Behavior smoke:

- health/readiness;
- session lookup;
- public model listing;
- one non-stream request through a fake upstream;
- one streaming request through a fake upstream;
- cancellation releases account/network ownership.

Additional checks:

- old `internal/runtime`, `internal/server`, and `internal/proxy` ownership trees are absent except paths explicitly approved in the final tree;
- no forwarding packages remain;
- one bootstrap creates one router.

**Cumulative completion target:** 36%.

---

# 10. Wave 4 — Boundary Enforcement and Contract Authority

**Concurrency:** five agents.

## Agent ImportBoundaryCheck

### Target

- `tools/verify-imports.ts`
- repository command wiring

### Change

Implement deterministic checks for forbidden package directions and forbidden generic package names. Reject old package paths and runtime imports from reference repositories.

### Acceptance

The tool fails on a controlled invalid fixture and passes the repository.

## Agent PublicContractAuthority

### Target

- `contracts/openapi/public.yaml`
- public gateway contracts and contract tests

### Change

Capture current public routes, status codes, headers, streaming media types, and bounded error shapes. Do not invent unsupported APIs.

### Acceptance

Every active public route is represented and checked against gateway behavior.

## Agent ConsoleContractAuthority

### Target

- `contracts/openapi/console.yaml`
- `router/internal/console/contracts`
- console contract tests

### Change

Define bounded console wire contracts for existing endpoints. Exclude secrets and full content. Preserve current paths during this stage.

### Acceptance

Every active console route has a checked contract and no storage model crosses the boundary.

## Agent MigrationIntegrity

### Target

- storage migrations, migration tests, repository bundle

### Change

Verify move integrity, deterministic versions, rollback-on-failure behavior, and repository ownership. Remove dead dashboard schema dependencies only after the later dashboard cutoff.

### Acceptance

Migration sequence is deterministic and current schemas upgrade without reordering.

## Agent PackageTestAlignment

### Target

- Go tests and root cross-process test paths after moves

### Change

Repair only path/package fallout from clean moves. Remove duplicate or obsolete tests that target deleted wrappers. Do not weaken assertions.

### Acceptance

Tests target final owners and no test imports old packages.

## Wave 4 gate G4

```text
bun run tools/verify-imports.ts
cd router && go test ./...
cd router && go vet ./...
cd router && go build ./...
cd dashboard && bun run test:ci
```

Additional checks:

- no forbidden package name exists;
- no old import path exists;
- OpenAPI route inventory matches runtime route inventory;
- no secret-bearing field exists in console schemas.

**Cumulative completion target:** 42%.

---

# 11. Foundation 5 — Protocol Decision Lock

Main performs this before Wave 5:

1. Land `ProcessingMode` and `CompatibilityDecision` contracts.
2. Establish immutable compatibility cache key.
3. Establish codec interface and raw passthrough interfaces.
4. Add differential fixture runner.
5. Add benchmark harness for request preparation and stream forwarding.
6. Assign exact surface files to agents.
7. Prohibit agents from changing common decision types during the wave.

Foundation gate:

- the current translation path still compiles behind the new decision contract;
- differential runner can compare semantic JSON and raw bytes;
- benchmarks run before optimization.

---

# 12. Wave 5 — PASS, PATCH, and Surface Codec Cleanup

**Concurrency:** five agents.

## Agent RequestFastPath

### Target

- protocol request preparation
- router request preparation bridge
- same-surface request tests and benchmarks

### Change

Implement decision-first request handling:

- PASS keeps original bytes;
- PATCH performs bounded targeted changes;
- TRANSLATE invokes codec once;
- REJECT occurs before account/network acquisition;
- remove ordinary full-body `map[string]any` sanitize path;
- preserve unknown same-surface fields.

### Acceptance

- PASS has zero canonical decode/encode;
- PATCH has no canonical graph;
- semantic fixtures remain correct;
- unsupported features fail before upstream work.

## Agent ResponseFastPath

### Target

- protocol response handling
- gateway response/stream bridge
- egress stream frame ownership

### Change

Implement raw same-surface non-stream and SSE passthrough. Extract bounded terminal usage without reconstructing every event. Preserve translated stream behavior for cross-surface requests.

### Acceptance

- same-surface frames do not allocate canonical events;
- exactly one terminal outcome;
- retry after client commit remains forbidden;
- cancellation closes upstream resources.

## Agent OpenAICodecs

### Target

- OpenAI Chat and Responses codec files
- OpenAI fixture tests

### Change

Separate OpenAI surface codec logic from generic pipeline logic, remove duplicated conversions, use typed canonical structures, and preserve tool, image, reasoning, usage, and streaming semantics.

### Acceptance

OpenAI same-surface and cross-surface fixture matrices pass with no silent field loss.

## Agent AnthropicCodec

### Target

- Anthropic Messages codec
- Anthropic fixture tests

### Change

Clean request, response, and event translation around one typed codec. Move provider-specific quirks out of generic protocol where they belong to an adapter.

### Acceptance

Anthropic tool calls, tool results, thinking, stop reasons, usage, errors, and streaming fixtures pass.

## Agent GeminiCodec

### Target

- Gemini generateContent codec
- Gemini fixture tests

### Change

Clean request, response, and stream translation around one typed codec. Preserve parts, tools, safety-relevant fields, finish reasons, and usage where supported.

### Acceptance

Gemini fixtures pass; unsupported semantic features return explicit capability errors.

## Wave 5 gate G5

```text
cd router && go test ./internal/protocol/... ./internal/gateway/... ./internal/router/...
cd router && go test -race ./internal/protocol/... ./internal/router/...
cd router && go test ./...
cd router && go build ./...
```

Behavior proof:

- byte-equal PASS request fixture;
- byte-equal PASS non-stream response fixture;
- raw SSE frame preservation;
- model-only PATCH preserving unknown fields;
- cross-surface OpenAI to Anthropic;
- cross-surface Anthropic to OpenAI;
- cross-surface OpenAI to Gemini;
- tool call and image cases;
- reject-before-acquire case.

Performance proof:

- compare request preparation benchmark to Foundation 0;
- compare same-surface stream benchmark to Foundation 0;
- no performance claim is accepted without recorded benchmark output.

**Cumulative completion target:** 55%.

---

# 13. Foundation 6 — Router Execution Lock

Main performs this before Wave 6:

1. Land immutable `RoutePlan`.
2. Land `AttemptContext` and `AttemptOutcome`.
3. Lock retry scope and client-commit rules.
4. Assign exact router files to each sub-owner.
5. Establish coordinator-only mutation rule.
6. Add attempt trace assertions used by all router tests.

---

# 14. Wave 6 — Router Decomposition

**Concurrency:** five agents.

## Agent AttemptCoordinator

### Target

- router coordinator
- attempt state
- outcome and retry classification integration

### Change

Extract one explicit attempt state machine from the large router path. Preserve route/member/refresh/repair budgets. Keep global retry decisions in the coordinator.

### Acceptance

Every attempt records start, classification, release, and terminal state exactly once.

## Agent SelectionPool

### Target

- account candidate acquisition
- selector
- pool readiness and exclusion

### Change

Separate deterministic selection from attempt progression. Preserve account exclusion, sticky/fallback/round-robin behavior, readiness, cooldown, quota, and least-inflight inputs.

### Acceptance

Selection is deterministic for a fixed snapshot; failed accounts are not accidentally reacquired.

## Agent StreamLifecycle

### Target

- router stream
- inflight registry
- continuation interaction

### Change

Own stream preflight, client commit, cancellation, terminal state, and inflight projection. Do not duplicate gateway/egress framing.

### Acceptance

No double terminal event, no retry after visible bytes, and all leases release on cancellation.

## Agent CatalogAndPlanCache

### Target

- router catalog
- compatibility/route plan cache interaction

### Change

Separate catalog build, resolution, snapshot, and immutable compiled plans. Serve hot plans from local memory keyed by catalog/capability generations. Use Redis only for distributed state or invalidation where required.

### Acceptance

No JSON marshal/unmarshal occurs on local compiled-plan hits; stale generation cannot execute as fresh.

## Agent RouterPoliciesAndCache

### Target

- admission
- continuation
- token budget interface
- optimizer
- response/content cache

### Change

Unify supporting router policies without moving them into generic helpers. Preserve bounded admission, reservation lifecycle, miss coalescing, compression threshold, and cache safety rules.

### Acceptance

Admission remains bounded; reservations close; compression runs at most once per semantic request; cache keys include all output-affecting inputs.

## Wave 6 gate G6

```text
cd router && go test ./internal/router/...
cd router && go test -race ./internal/router/...
cd router && go test ./...
cd router && go build ./...
```

Required scenarios:

- first account success;
- quota failover;
- transient retry;
- permanent failure without retry;
- same-account refresh retry;
- combo member exhaustion;
- route-wide budget exhaustion;
- cancellation release;
- stream preflight failure;
- stream terminal exactly once;
- stale catalog generation rejection;
- cache miss coalescing;
- token reservation commit/release.

**Cumulative completion target:** 65%.

---

# 15. Wave 7 — Provider, Account, and Egress Behavior Cutoff

**Concurrency:** five agents.

## Agent ProviderCapabilities

### Target

- provider catalog, capabilities, policy, and classification

### Change

Make provider capabilities explicit for surfaces, streaming, tools, images, reasoning, batch, auth, and quota. Consolidate error classification facts consumed by router.

### Acceptance

Every release provider has one capability record and classification map.

## Agent ProviderAdapters

### Target

- provider adapters and provider-specific repairs

### Change

Move provider deviations out of generic protocol. Adapters prepare provider-specific endpoint, headers, and bounded wire changes. They must not select accounts or retry globally.

### Acceptance

Each adapter returns prepared attempt data and classified results through the shared interfaces.

## Agent AccountAuth

### Target

- account auth registry, OAuth/device flows, credential import, refresh

### Change

Unify provider auth drivers, preserve refresh coalescing and distributed lease behavior, and keep secrets request-scoped.

### Acceptance

One auth registry, one refresher, no plaintext secret in logs/contracts, concurrent refresh proof passes.

## Agent AccountHealthQuota

### Target

- account health, quota, cooldown, model locks, readiness

### Change

Unify state transitions consumed by selection. Separate provider observations from router decisions. Preserve durable convergence and bounded retry times.

### Acceptance

Quota/cooldown/readiness transitions deterministically affect eligibility.

## Agent EgressRuntime

### Target

- outbound client, connection pool, proxy network, SSE, compression, errors

### Change

Optimize connection reuse and byte forwarding without weakening outbound security. Make response-body and connection ownership explicit.

### Acceptance

No leaked bodies/connections; proxy route identity remains attached to outcomes; SSRF tests pass.

## Wave 7 gate G7

```text
cd router && go test ./internal/providers/... ./internal/accounts/... ./internal/egress/... ./internal/router/...
cd router && go test -race ./internal/accounts/... ./internal/egress/... ./internal/router/...
cd router && go test ./...
```

Required provider matrix:

- provider registration;
- model capability lookup;
- API-key path;
- OAuth refresh path;
- quota observation;
- cooldown transition;
- provider error classification;
- same-surface adapter request;
- cross-surface adapter request;
- outbound proxy success/failure.

**Cumulative completion target:** 73%.

---

# 16. Foundation 8 — Safe Batch Writer Contract

Main locks:

- bulk telemetry repository interface;
- bounded writer configuration;
- flush-on-count, flush-on-time, and shutdown drain semantics;
- queue metrics names;
- maintenance scheduler ownership;
- no request-content persistence in the batch writer.

---

# 17. Wave 8 — Automatic Maintenance Batching

**Concurrency:** five agents.

## Agent TelemetryBatchWriter

### Target

- telemetry queue/writer

### Change

Implement bounded automatic grouping and flush lifecycle for metadata events. Keep request path fail-open and non-blocking.

### Acceptance

Count/time flush, bounded queue, drop metric, and shutdown drain work deterministically.

## Agent TelemetryBulkStorage

### Target

- storage telemetry repository

### Change

Implement transactional bulk insert for metadata rows, bounded retry, and row-specific failure isolation only when necessary.

### Acceptance

One batch produces one transaction in the normal path; duplicate and invalid rows do not silently lose valid rows.

## Agent QueueMetricsLifecycle

### Target

- telemetry metrics and app shutdown wiring

### Change

Expose depth, size, flush latency, drops, persistence failures, and drain outcome. Wire lifecycle without making requests wait.

### Acceptance

Metrics update under success, overflow, failure, and shutdown scenarios.

## Agent AccountMaintenanceBatch

### Target

- scheduled quota refresh and account health work

### Change

Group background quota/health work by provider capability with bounded workers, cancellation, jitter, and per-account isolation. Do not combine credentials.

### Acceptance

Automatic maintenance is bounded, cancellable, and does not block routing.

## Agent BatchLoadProof

### Target

- root load/performance scenarios for metadata and maintenance batches

### Change

Add behavioral load proof for queue saturation, bulk flush, database failure, graceful drain, and concurrent quota refresh.

### Acceptance

Tests fail on unbounded queue growth, lost drain, or credential/account mixing.

## Wave 8 gate G8

```text
cd router && go test ./internal/telemetry/... ./internal/storage/... ./internal/accounts/... ./internal/app/...
cd router && go test -race ./internal/telemetry/... ./internal/accounts/...
cd router && go test ./...
```

Performance proof:

- compare database round trips per metadata event;
- record batch size distribution;
- record queue drops under configured overload;
- confirm request latency is not coupled to database flush latency.

**Cumulative completion target:** 79%.

---

# 18. Foundation 9 — Native Batch Contracts

Main lands and locks:

- `BatchKey`, `BatchJob`, `BatchItem`, and states;
- repository interfaces;
- provider native-batch capability interface;
- bounded parallel fallback contract;
- public batch API contract only for behavior implemented in this plan;
- console batch contract;
- cancellation, expiration, and partial failure rules.

No fake native provider implementation is allowed. Providers without verified native support use the bounded individual-request fallback.

---

# 19. Wave 9 — Model Batch Execution

**Concurrency:** five agents.

## Agent BatchStorage

### Target

- storage batch models, migrations, repositories

### Change

Implement durable jobs/items, deterministic ordering, state transitions, expiry, cancellation, and result metadata without storing prohibited secret content.

### Acceptance

Transitions are transactional; item IDs and positions remain stable; recovery after process restart works.

## Agent BatchScheduler

### Target

- router batch scheduler and grouping

### Change

Implement bounded queues and compatibility grouping by full `BatchKey`. Interactive requests bypass wait.

### Acceptance

Incompatible account, tenant, model, surface, network, policy, or translation keys never group.

## Agent BatchWorker

### Target

- router batch worker
- provider batch capability integration

### Change

Execute verified native batches and bounded parallel fallback. Map results by item ID and classify partial failures independently.

### Acceptance

Partial success, provider-wide failure, retry, cancellation, and expiry behave deterministically.

## Agent BatchAPIs

### Target

- gateway batch endpoints
- console batch endpoints and contracts

### Change

Expose implemented submit, list, get, cancel, and progress behavior. Keep public and console authorization separate.

### Acceptance

HTTP states and response contracts match durable job state; unauthorized access cannot enumerate jobs.

## Agent BatchScenarios

### Target

- root contract/integration/scenario tests for batch

### Change

Cover native-capable fake provider, fallback provider, incompatible grouping, partial failure, restart recovery, cancellation, expiry, and progress streaming.

### Acceptance

Scenarios fail on item misrouting, credential mixing, lost progress, or incorrect terminal state.

## Wave 9 gate G9

```text
cd router && go test ./internal/router/batch/... ./internal/storage/... ./internal/gateway/... ./internal/console/...
cd router && go test -race ./internal/router/batch/...
cd router && go test ./...
```

Behavior smoke:

- submit batch;
- observe queued/running/completed states;
- verify stable item results;
- cancel queued and running jobs;
- restart and resume/reconcile unfinished work;
- prove interactive stream has no batch wait.

**Cumulative completion target:** 86%.

---

# 20. Wave 10 — Complete Go Console Wiring

**Concurrency:** five agents.

## Agent ConsoleOverviewUsage

### Target

- overview and usage console services, API routes, contracts

### Change

Wire real router/telemetry summary and usage projections. Remove placeholder or duplicated calculations.

### Acceptance

Dashboard totals derive from one telemetry source and bounded query windows.

## Agent ConsoleRequestsLogs

### Target

- requests, logs, client-errors services and SSE

### Change

Expose bounded redacted request/log projections, live streams, and browser client-error ingestion through Go.

### Acceptance

No secret/full content leakage; heartbeat and reconnect cursors are explicit; client errors are rate-limited.

## Agent ConsoleProvidersAccountsQuota

### Target

- provider, account, quota console services and routes

### Change

Wire registry, account authority, health, quota, mutations, and batch account operations to final owners.

### Acceptance

Mutations return committed state; provider/account identity is consistent with router selection.

## Agent ConsoleProxiesSettingsShare

### Target

- proxy, settings, share, session console services/routes

### Change

Wire egress proxy state, application settings, session behavior, and public share projections. Preserve authorization boundaries.

### Acceptance

Proxy tests affect the same egress records used by routing; public share remains credential-free.

## Agent ConsoleBatchesContracts

### Target

- batch console service
- complete `console.yaml`
- contract verification

### Change

Complete batch projection and reconcile every active console route with the schema authority.

### Acceptance

Runtime route inventory and console OpenAPI inventory match; all fields are bounded and redacted.

## Wave 10 gate G10

```text
cd router && go test ./internal/console/... ./internal/gateway/... ./internal/router/... ./internal/telemetry/...
cd router && go test ./...
cd router && go build ./...
```

HTTP contract smoke:

- session;
- dashboard summary;
- usage;
- request list and SSE;
- providers/accounts/quota;
- proxies;
- settings;
- logs and SSE;
- batches;
- share;
- client errors.

**Cumulative completion target:** 92%.

---

# 21. Foundation 11 — Dashboard Integration Lock

Main performs before UI delegation:

1. Move `App`, router, routes, and session to `dashboard/src/app`.
2. Establish `dashboard/src/api/client.ts`, `routes.ts`, `errors.ts`, and `sse.ts`.
3. Generate or check `dashboard/src/api/contracts.ts` from `console.yaml`.
4. Establish one query/resource pattern.
5. Establish one mutation error pattern.
6. Establish one SSE reconnect/cursor pattern.
7. Assign feature folders to agents.
8. Keep existing visual language unless a feature requires correction.

Foundation gate:

```text
cd dashboard && bun run test:ci
```

The shell, login redirect, one query, one mutation, and one SSE resource must work through the new foundation before feature agents start.

---

# 22. Wave 11 — Dashboard Feature Wiring

**Concurrency:** five designer agents or task agents with the design skill, each owning complete feature slices.

## Agent DashboardOverviewUsage

### Target

- overview and usage pages, composables, feature-local components/tests

### Change

Move to feature ownership and wire real console contracts. Remove placeholder data and duplicate formatting/state.

### Acceptance

Overview and Usage render loading, success, empty, stale, and error states from real API responses.

## Agent DashboardRequestsLogs

### Target

- requests and console log features

### Change

Wire bounded lists and SSE using the shared API layer. Preserve virtualization where needed. Handle reconnect without duplicates.

### Acceptance

Live events append once, reconnect resumes correctly, and redacted data is rendered safely.

## Agent DashboardProvidersAccountsQuota

### Target

- providers, accounts, and quota features

### Change

Break the bloated Providers page into feature-owned presentation/state without creating generic wrappers. Wire catalog, account mutations, batch mutations, health, and quota refresh.

### Acceptance

Mutations reconcile with server state; provider/account/quota ownership is visible and consistent.

## Agent DashboardProxiesBatches

### Target

- proxy and batch features

### Change

Wire egress proxy management and durable batch lifecycle, including progress, partial failures, cancellation, and expiry.

### Acceptance

Proxy tests and batch operations show committed server outcomes, not optimistic fake state.

## Agent DashboardSettingsAccess

### Target

- settings, login, share, landing, layout/navigation

### Change

Move features, preserve session redirect behavior, wire settings/share contracts, and keep route-level lazy loading. Remove duplicate layout and shared-component abstractions.

### Acceptance

Authenticated and public routes preserve access rules; navigation contains every final feature once.

## Wave 11 gate G11

```text
cd dashboard && bun run test:ci
cd router && go test ./internal/console/...
bun run tools/validate-fullstack.ts
```

Main browser verification on the actual running surface:

- login redirect and session restoration;
- Overview;
- Requests live updates;
- Usage;
- Providers and account mutations;
- Quota refresh;
- Proxy mutation/test;
- Batch submission/progress/cancel;
- Logs stream;
- Settings mutation;
- public Share;
- landing page;
- viewport and keyboard smoke for primary navigation.

**Cumulative completion target:** 96%.

---

# 23. Wave 12 — Dashboard Backend Cutoff, Deployment, and Documentation

**Concurrency:** five agents.

## Agent DashboardBackendRemoval

### Target

- dashboard Bun server
- dashboard PostgreSQL/SQLite/migration/cache/store helpers
- dashboard migrations/data
- package dependencies and tests

### Change

Delete the auxiliary backend after Go client-error/log endpoints are proven. Remove `pg`, SQLite code, server script, backend tests, migrations, and data volume ownership. Keep the SPA build clean.

### Acceptance

Dashboard has no server entrypoint, SQL dependency, migration runner, or runtime data directory.

## Agent DeployCutover

### Target

- `deploy/docker/Dockerfile`
- `deploy/docker/compose.yaml`
- nginx configuration
- Railway configuration

### Change

Remove dashboard-audit image/service/volume, build final `router/`, serve static dashboard, and proxy public/console/share routes to Go. Preserve non-root runtime and health behavior.

### Acceptance

Compose contains PostgreSQL, Redis, router, and dashboard only; no auxiliary backend remains.

## Agent ToolingFinalization

### Target

- root `tools`
- root package commands
- Makefile
- Windows runner

### Change

Finalize new paths and commands for dev, no-open dev, Windows, build, unit tests, full-stack validation, import checks, benchmarks, and smoke tests.

### Acceptance

Every documented command resolves to one existing executable path.

## Agent DocumentationCutover

### Target

- README
- changelog
- docs architecture/deployment/operations

### Change

Update final ownership, request flow, PASS/PATCH/TRANSLATE behavior, batch behavior, dashboard wiring, deployment, and reference disposition. Remove obsolete daemon and auxiliary-backend instructions.

### Acceptance

Documentation matches final source tree and commands; no old authority remains documented as active.

## Agent EndToEndHarness

### Target

- root contract, integration, performance, and smoke runners

### Change

Complete deterministic local harness for dependency startup, migration, router readiness, fake upstreams, public API, console API, SSE, batch, dashboard, and graceful shutdown.

### Acceptance

One documented command executes the complete local smoke without hidden manual steps.

## Wave 12 gate G12

```text
cd router && go test ./...
cd router && go test -race ./internal/router/... ./internal/accounts/... ./internal/egress/... ./internal/telemetry/...
cd router && go vet ./...
cd router && go build ./cmd/cartethyia
cd dashboard && bun run test:ci
bun run tools/verify-imports.ts
bun run tools/validate-fullstack.ts
docker compose -f deploy/docker/compose.yaml config
docker build -f deploy/docker/Dockerfile --target runtime .
docker build -f deploy/docker/Dockerfile --target dashboard .
```

Cutoff checks:

- no dashboard server script;
- no dashboard `pg` or SQLite dependency;
- no dashboard-audit image/service/volume;
- no old root deployment paths;
- no old package paths;
- no runtime reference to either reference repository.

**Cumulative completion target:** 99%.

---

# 24. Wave 13 — Independent Audit

**Concurrency:** five read-only or verification agents.

## Agent ArchitectureReviewer

**Agent type:** reviewer.

Review ownership, import direction, clean cutover, duplicate authorities, dead code, wrappers, and oversized new abstractions. Report evidence by file and symbol.

## Agent SecurityReviewer

**Agent type:** security-reviewer.

Review authentication, session, credential handling, secret storage, logs, telemetry, outbound SSRF policy, proxy credentials, batch tenant/account isolation, public share, and dashboard client errors.

## Agent PerformanceReviewer

**Agent type:** task.

Run approved benchmarks and profiles for PASS, PATCH, TRANSLATE, stream forwarding, selection, telemetry bulk writes, and batch scheduling. Compare against Foundation 0.

## Agent ContractReviewer

**Agent type:** reviewer.

Review public/console OpenAPI parity, compatibility fixtures, stream terminal semantics, error shapes, batch state transitions, and unsupported-feature rejection.

## Agent DashboardReviewer

**Agent type:** designer.

Review the actual dashboard surface for route coverage, loading/error/empty/stale states, mutation feedback, keyboard navigation, responsive layout, and live stream behavior.

## Wave 13 gate G13

Main triages every finding:

- blocking findings are fixed before final verification;
- advisory findings are fixed when they affect the approved architecture or observable behavior;
- rejected findings require evidence in the execution log;
- fixes larger than Main integration work become a repair wave of at most five agents;
- G13 reruns after repairs.

**Cumulative completion target:** 100% architecture implementation, pending final Main proof.

---

# 25. Final End-to-End Verification — Main

No subagent result substitutes for this proof.

## 25.1 Static verification

```text
bun run tools/verify-imports.ts
cd router && go vet ./...
cd router && go build ./cmd/cartethyia
cd dashboard && bun run test:ci
docker compose -f deploy/docker/compose.yaml config
```

## 25.2 Test verification

```text
cd router && go test ./...
cd router && go test -race ./internal/router/... ./internal/accounts/... ./internal/egress/... ./internal/telemetry/...
bun run tools/validate-fullstack.ts
```

## 25.3 Container verification

1. Build runtime image.
2. Build dashboard image.
3. Start PostgreSQL and Redis.
4. Start router and wait for readiness.
5. Start dashboard and wait for HTTP readiness.
6. Confirm only four services exist: PostgreSQL, Redis, router, dashboard.
7. Confirm dashboard-audit does not exist.
8. Confirm non-root router process and health check.
9. Confirm graceful stop drains telemetry and batch workers.

## 25.4 Public API scenarios

For each supported surface:

| Surface | Non-stream | Stream | Error | Tool case | Image case where supported |
|---|---:|---:|---:|---:|---:|
| OpenAI Chat | required | required | required | required | required when supported |
| OpenAI Responses | required | required | required | required | required when supported |
| Anthropic Messages | required | required | required | required | required when supported |
| Gemini generateContent | required | required | required | required | required when supported |

Verify:

- authentication;
- model resolution;
- provider/account selection;
- outbound proxy selection;
- PASS byte preservation;
- PATCH unknown-field preservation;
- TRANSLATE semantic parity;
- response status/header/media type;
- usage accounting;
- terminal stream event;
- cancellation release.

## 25.5 Router failure scenarios

- rate limit causes classified failover;
- quota exhaustion changes eligibility;
- transient failure retries within budget;
- permanent client/protocol failure does not retry;
- refresh retry uses the explicit same-account exception;
- route and per-member budgets stop retry explosion;
- stale catalog generation is not executed as fresh;
- client-visible stream bytes prevent ordinary retry;
- all account/network/token reservations release.

## 25.6 Batch scenarios

- explicit batch submit/list/get;
- compatible items group;
- incompatible account/tenant/model/surface/network/policy items do not group;
- verified native provider path where implemented;
- bounded parallel fallback;
- partial success;
- item-specific failure;
- provider-wide failure;
- queued cancellation;
- running cancellation;
- expiry;
- process restart recovery;
- progress stream;
- interactive streaming bypasses batch wait.

## 25.7 Console API scenarios

- session and authorization;
- Overview data;
- Requests and in-flight SSE;
- Usage;
- Providers;
- Accounts and batch mutations;
- Quota refresh;
- Proxies and proxy test;
- Batches;
- Logs and SSE;
- Settings;
- Share;
- browser client errors.

Verify all outputs are bounded and redacted.

## 25.8 Dashboard browser scenarios

Use the actual running browser surface:

- unauthenticated redirect;
- login and session restoration;
- every navigation route loads;
- loading, empty, stale, error, and success states;
- mutations show committed server results;
- SSE reconnect does not duplicate entries;
- batch progress and partial failures render correctly;
- public share does not require console credentials;
- keyboard navigation works for primary actions;
- primary desktop and narrow viewport layouts remain usable.

## 25.9 Performance verification

Compare Foundation 0 and final benchmark outputs:

| Scenario | Required proof |
|---|---|
| PASS request | zero canonical decode/encode and measured allocation reduction |
| PATCH request | no canonical graph and one bounded output |
| TRANSLATE request | one decode and one encode |
| same-surface stream | raw-frame forwarding and reduced frame allocations |
| translated stream | incremental processing without full buffering |
| compatibility hot cache | no JSON serialization on local hit |
| telemetry | reduced database round trips and bounded queue |
| batch scheduler | bounded memory/workers and no interactive wait |

A performance target may miss its proposed percentage if correctness is preserved, but any regression must be investigated and documented before acceptance.

## 25.10 Security verification

- no secret in console contracts;
- no secret in logs or telemetry;
- no credential mixing in batches;
- no authorization bypass between public, gateway, and console routes;
- outbound policy blocks prohibited destinations;
- proxy credentials are not exposed;
- browser client errors are bounded and rate-limited;
- public Share remains read-only and credential-free;
- container runtime remains non-root.

## 25.11 Structural verification

The following must not exist:

```text
daemon/
scripts/
docker/
router/internal/runtime/
router/internal/server/
router/internal/proxy/
router/internal/storage/
router/internal/observability/
router/internal/security/
dashboard/src/server/
dashboard/data/
dashboard/migrations/
```

The following generic Go packages must not exist:

```text
utils
helpers
common
shared
core
services
```

`console/services` is allowed because it is a named console sub-owner defined by the architecture. A root or cross-domain generic `services` package is forbidden.

---

# 26. Completion Ledger

| Stage | Weight | Verification owner | Advance condition |
|---|---:|---|---|
| Foundation 0 | 3% | Main | baselines and contracts recorded |
| Wave 1 | 7% | Main G1 | root cutover green |
| Wave 2 | 12% | Main G2 | leaf owners green |
| Wave 3 | 14% | Main G3 | runtime owners green |
| Wave 4 | 6% | Main G4 | boundaries and contracts green |
| Wave 5 | 13% | Main G5 | PASS/PATCH/TRANSLATE green |
| Wave 6 | 10% | Main G6 | router decomposition green |
| Wave 7 | 8% | Main G7 | provider/account/egress green |
| Wave 8 | 6% | Main G8 | maintenance batching green |
| Wave 9 | 7% | Main G9 | model batches green |
| Wave 10 | 6% | Main G10 | Go console wiring green |
| Wave 11 | 4% | Main G11 | dashboard features green |
| Wave 12 | 3% | Main G12 | backend cutoff/deploy green |
| Wave 13 | 1% | Main G13 | independent audits resolved |
| Final proof | acceptance | Main | all end-to-end checks observed |

Total implementation weight: **100%**.

---

# 27. Definition of Done

The refactor is complete only when all statements are true:

- [ ] `router/` is the only Go runtime root.
- [ ] one gateway owns all public ingress.
- [ ] one protocol owner decides PASS, PATCH, TRANSLATE, or REJECT.
- [ ] PASS performs no canonical decode or encode.
- [ ] PATCH preserves unknown same-surface fields.
- [ ] TRANSLATE performs one canonical decode and encode per direction.
- [ ] one router owns selection, attempts, retry, failover, stream lifecycle, cache, and batch.
- [ ] one provider registry and capability catalog exist.
- [ ] one account authority and auth registry exist.
- [ ] one egress owner handles outbound HTTP, SSE, network proxies, and outbound policy.
- [ ] one storage owner handles PostgreSQL models, repositories, transactions, and migrations.
- [ ] one telemetry owner handles metrics, metadata, evidence, usage, capture, and redaction.
- [ ] telemetry persistence batches automatically without blocking requests.
- [ ] model batch grouping is bounded and security-scoped.
- [ ] interactive streams do not wait for batches.
- [ ] one Go console API serves the operator dashboard.
- [ ] dashboard is a pure SPA with no SQL, SQLite, migration, or Bun server ownership.
- [ ] dashboard-audit service and image are removed.
- [ ] public and console contracts match runtime routes.
- [ ] all old folders, imports, wrappers, aliases, and duplicate paths are removed.
- [ ] reference repositories are behavior sources only, never runtime dependencies.
- [ ] Go build, unit tests, race tests, dashboard tests/build, import checks, Docker builds, smoke scenarios, browser scenarios, batch scenarios, and security checks pass.
- [ ] final performance comparison is recorded with no unexplained regression.

---

# 28. Execution Start Rule

When implementation begins:

1. Main executes Foundation 0.
2. Main records baseline failures and locks shared contracts.
3. Main delegates Wave 1 as one batch of five subagents.
4. Main waits for all five results.
5. Main verifies G1.
6. Only after G1 passes, Main delegates Wave 2.
7. This cycle continues through Wave 13.
8. Main performs final end-to-end verification.
9. Completion is reported only with observed command, runtime, API, batch, and browser evidence.
