
# Cartethyia Develop

The single skill for every repo modification. Jump to your section; all share one Verify block at the end.

## When to use

| Symptom | Section |
|---|---|
| New to the repo / where is the authority? | 0 Orientation |
| Add or extend a bundled provider | 1 Add provider |
| Provider stamps a CLI/client version in headers | 2 Version resolver |
| New Postgres column or routing setting | 3 Schema change |
| New field on the Console Log line | 4 Console-log field |
| Ready to commit / gates and constraints | 5 Change gate |
| Delete a whole feature cluster | 6 Feature removal |
| Delete files / measure a tree / check path readers | 7 Safe removal |
| Refactor left re-exports or type aliases | 8 Compat shims |

## 0 Orientation

### Goal

Use when new to the repo or unsure which file owns a behavior; done when you can name the authority file for ingress, routing, dispatch, registry, and config without guessing.

### Procedure

1. Capture state first: `git status --short` plus `git diff --stat`. Treat uncommitted work as the real state. If `.codegraph/codegraph.db` exists the index is usable, but re-verify indexed hits with `Grep`/`Read` when files changed after its sync point.
2. Read in order: `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CHANGELOG.md` head (`## Unreleased` first), then the canonical layer doc for your area — one doc per top-level `src/` folder, named for the layer (`src/transport/TRANSPORT.md`, `src/providers/PROVIDERS.md`, `src/persistence/PERSISTENCE.md`, `src/observability/OBSERVABILITY.md`), then `package.json` scripts, then the boot chain `src/main.ts` → `src/runtime/lifecycle.ts` → `src/runtime/dependencies.ts` → `src/app.ts`.
3. Authority map (no others):
   - Ingress: `src/transport/middleware/pipeline.ts` (composition); `src/transport/middleware/ingress.ts` (stages, `finalizeRequestTelemetry`, `isProxyDispatchRoute`).
   - Eligibility: `src/transport/routing/router.ts` only (`RoutingEngine.plan`, admission reading `candidate.max_inflight`).
   - Model/errors: `src/transport/canonical-model.ts` (wire families, canonical request/event vocabulary); `src/transport/gateway-error.ts` (`GatewayError`, stable codes, public-detail sanitizers).
   - Surfaces: `src/transport/surface/` (`chat/adapter.ts`, `responses/adapter.ts`, `messages/adapter.ts`, `completion.ts`).
   - Codecs: `src/protocol/request/`, `src/protocol/response/` (`chat.ts`, `responses.ts`, `messages.ts`, `codex.ts`), `src/protocol/registry.ts`, `src/protocol/transport/openai.ts`, `src/protocol/primitives.ts`.
   - Capabilities: `src/transport/translation/capabilities.ts` plus `src/transport/request/preparer.ts` (degrade order: generation controls/extensions, prompt caching, structured output, reasoning, tools, then attached media; hosted `web_search` is not degradable and fails the request when the chosen model lacks it). Tool tracking: `src/transport/tool-identity.ts`.
   - Dispatch: `src/providers/compatible-adapter.ts` (awaited `buildExtraHeaders`), `src/transport/dispatch/proxy-request.ts`, `src/transport/dispatch/attempt-finalize.ts` (`completeAttempt`), `src/transport/dispatch/leases.ts`, `src/transport/dispatch/upstream.ts`.
   - Registry: `src/providers/provider-registry.ts`, `src/providers/default-registry.ts`, `src/providers/provider-metadata.ts`, `src/providers/model-definition.ts` (`defineModel`).
   - Config: `src/config.ts` is the only sanctioned multi-subsystem env reader; single-subsystem reads live next to their consumer and must be documented in `.env.example` (`test/config-env-drift.test.ts` enforces this).
   - Network: `src/network/ssrf.ts`, `src/network/outbound-fetch.ts`, `src/network/pool/`.
   - Observability: `src/observability/log-ring.ts`, `src/observability/payload-capture.ts`, `src/observability/telemetry-buffer.ts`.
   - Console: `src/console/providers/catalog/`, `src/console/providers/detail/` (`contracts.ts`, `store.ts`, `routes.ts` each), `src/console/domains/logs.ts`.
   - Persistence: `src/persistence/schema.ts`, `src/persistence/postgres.ts` (`DATABASE_URL` only source, `MIGRATION_LEDGER_TABLE`), `drizzle/migrations/0000_baseline.sql` (the only auto-applied migration) plus `drizzle/migrations/manual/` for hand-run statements on already-migrated databases.
   - Scripts are flat under `scripts/` (`ops-run-tests.ts`, `ops-migrate.ts`, `ops-setup.ts`, `ops-doctor.ts`, `build-aot.ts`, `ci-check-coverage.ts`); no `scripts/ops/` exists.

```bash
git status --short
git diff --stat
bun run typecheck
```

### Pitfalls

- WIP beats docs: a stale canonical layer doc never overrides the code in
  `router.ts`, `route-catalog.ts`, or `compatible-adapter.ts`.
- Capability flags change the upstream payload; modalities fuse while structural gaps degrade-then-reject. Telemetry is metadata-only and never blocks requests.
- Ambiguous bare model ids are rejected, not guessed; route-contract changes need `dashboard:typecheck`; renames must pass `test/architecture/*-naming.test.ts`; dispatch errors use `GatewayError`.

### Verify checklist

- [ ] You can state the authority file for your change from the map above; shared Verify block: `bun run typecheck` plus the focused suite for your tree.

## 1 Add provider

### Goal

Use when adding or extending a bundled provider; done when the provider dispatches end-to-end, appears in the dashboard, and its catalog seeds without endpoint conflicts.

### Procedure

1. Identity row in `src/providers/provider-metadata.ts`: append to `RAW_BUNDLED_PROVIDER_METADATA` (`id`, `displayName`, `baseUrl` as the true origin root, no version segment unless genuine, e.g. `https://api.openai.com`). Optional `wireFamilyDefault` (default `chat`), `requiresAccount` (only `false` for genuinely public endpoints like `opencodeft`), `defaultBypassProxy`, `jwtVerification`, `credentialUrl`. `BundledProviderId` derives from this array.
2. Capabilities entry in `src/providers/default-registry.ts`: add `PROVIDER_CAPABILITIES.<id>` — a missing key is a compile error via the `satisfies Record<BundledProviderId, …>` check. Keep every loader lazy (`await import()`; `oauthCapability()`, `quotaCapability()`, `openAIModelDiscovery()` helpers). Key-only hosts reuse `configuredProvider(id)` backed by `GENERIC_API_KEY_SPECS` in `src/providers/integrations/configured-openai-providers.ts`.
3. Integration module under `src/providers/integrations/`: mirror a sibling. Nested dirs (`buddy/`, `claude-code/`, `cline/`, `codex/`, `grok/`, `cursor/`, `devin/`, `antigravity/`, `muse/`, `kimi/`, `zai/`) for OAuth/quota providers: `<id>.ts` (`OpenAICompatibleAdapter` + `withBearerAuthentication`), `<id>-shared.ts` (awaited `buildExtraHeaders`, in-place `prePayload`, `defineModel` from `../../model-definition`), `<id>-oauth.ts`, `<id>-quota.ts`. Versioned providers register their resolver in `src/providers/operations/client-versions.ts`. Flat files (`commandcode.ts`, `qoder.ts`, `gemini.ts`, `agentrouter.ts`, `inferhub.ts`, `cloudflare.ts`) for simple or bespoke wires. Catalog rows use `defineModel({ id, endpoint, vision, reasoning, toolCall })`; `endpoint` becomes `ModelDefinition.endpointPath` (family defaults `/chat/completions`, `/responses`, `/messages` when omitted).
4. Endpoint gotcha: dispatch reads each row's `ModelDefinition.endpointPath` (via `candidate.endpoint_path` in `compatible-adapter.ts` `executeTransport`), not `endpoint_paths_by_wire_family`. `bundledModelCatalog()` in `src/providers/operations/provider-catalog-service.ts` throws on same-family conflicts, so a version-less `baseUrl` plus a versioned chat path means setting explicit `endpoint` on every row of that family.
5. Dashboard mirrors (all hand-maintained copies — browser code must never import a backend module; see `dashboard/README.md`): the display name in `BUILT_IN_PROVIDER_DISPLAY_NAMES` (`dashboard/src/lib/provider-names.ts`), an `iconAssets` entry in `dashboard/src/components/ProviderIcon.tsx`, placement in `SECTIONS` plus `FOUNDING_IDS` / `FREE_LIMITED_IDS` / `FREE_AVAILABLE_IDS` in `dashboard/src/routes/Providers.tsx`, and `PROXY_UNSUPPORTED_HINT_PROVIDERS` in `dashboard/src/lib/use-routing-strategy.ts` when the provider cannot route through a network pool. The OAuth section derives from `oauthFlows` presence, so it needs no list edit. Two parity tests fail the moment a bundled ID is missing from the display-name or icon map (`dashboard/test/provider-display-names-parity.test.ts`, `dashboard/test/provider-lists-parity.test.ts`), so run `bun run dashboard:test` before claiming the provider is wired. Touch `README.md` only if it already carries a provider count/table.
6. Seed/restart: `seedBundledModels()` in `src/providers/operations/provider-catalog-seeder.ts` upserts on `(provider_id, model_id, endpoint_path)` and deletes stale `source = 'builtin'` rows; `enabled` is operator-owned and never reset. Static catalog changes need a backend restart (boot path `bundledModelCatalog()` plus `seedBundledModels()` in `src/runtime/dependencies.ts`).
7. Tests in `test/providers/integrations/<id>/`: stub fetch as `as typeof fetch`, never hit the network. Nothing pins a provider *number* — the contract is coverage: `test/providers/default-registry.test.ts` asserts set equality between `BUNDLED_PROVIDER_IDS`, the registry's registered ids, `PROVIDER_CAPABILITIES` keys, and `BUNDLED_PROVIDER_MODULES`, and the dashboard parity tests assert every bundled id has a display name and icon, so a new id must land in every mirror rather than a count being bumped.

```bash
bun run typecheck
bun run scripts/ops-run-tests.ts test/providers
bun run test:contracts
bun run dashboard:typecheck
```

```ts
// default-registry.ts — keep await import() lazy
qoder: {
  loadAdapter: async () => (await import("./integrations/qoder")).createQoderAdapter(),
  loadModels: async () => (await import("./integrations/qoder")).QODER_MODELS,
},
```

### Pitfalls

- Eager imports pull protobuf-heavy adapters into startup; keep `await import()` lazy.
- `endpoint_paths_by_wire_family` is only the `resolveEndpoint` fallback — conflicting row endpoints throw at boot, so fix rows, not the map.
- Dashboard display names and `PROXY_UNSUPPORTED_HINT_PROVIDERS` are intentional copies; sync strings, never imports.
- DB-gated suites skip without `CARTETHYIA_TEST_DATABASE_URL` (`test/helpers/db-gate.ts`) — when set they run against it, not `DATABASE_URL`. Report skips, not passes.

### Verify checklist

- [ ] `bun run typecheck`, focused `bun run scripts/ops-run-tests.ts test/providers`, `bun run test:contracts`, `bun run dashboard:typecheck`; shared Verify block green.

## 2 Version resolver

### Goal

Use when a provider gates requests on a CLI/client version stamped into headers; done when the first dispatch already carries the current version with no race and offline mode works on the pinned fallback.

### Procedure

1. The race: `OpenAICompatibleAdapter.prepareHeaders()` in `src/providers/compatible-adapter.ts` awaits `buildExtraHeaders`, but a sync builder calling only sync `get()` plus fire-and-forget `refresh()` stamps the pinned fallback until discovery lands. Fix: `await` the resolver's `ensure()` inside the async header builder before `get()`. Fallback applies only on a real network error.
2. Add or change a provider entry in `VERSION_SOURCES` (`src/providers/operations/client-versions.ts`)
   plus its instance in the `resolvers` map in the same file: unique `key`,
   pinned `fallback`, and source URLs/parsers. The factory
   `createClientVersionResolver()` itself lives in
   `src/providers/operations/client-version-resolver.ts`. Keep non-version
   upstream fingerprint parsing in its dedicated helper. The shared cache
   deduplicates concurrent fetches, evicts failures, and keeps dispatch on the
   pinned fallback offline.
3. Await the resolver at every async header builder that needs a fresh version;
   sync builders may use `get()` only after an awaited warm-up.
4. Tests mirror the provider surface: reset the shared resolver, stub fetch as
   `as typeof fetch`, and assert the discovered value and the fallback on
   failure.

```ts
import { VERSION_SOURCES, resolveQoderVersion } from "../providers/operations/client-versions";

// Add one table entry; consumers await the shared resolver before first dispatch.
const qoderSource = VERSION_SOURCES.qoder;
const qoderFallback = qoderSource.fallback;
await resolveQoderVersion();
console.log(qoderFallback);
```

```bash
bun run typecheck
bun run scripts/ops-run-tests.ts test/providers/integrations/qoder
```

### Pitfalls

- Calling `get()` before an awaited `resolve*Version()` serves the pinned
  fallback on cold start; that is intentional only for offline/error paths.
- Duplicate table keys or provider-specific parsers in the shared table can
  cross-wire versions; keep keys unique and isolate non-version fingerprints.
- PowerShell operators translate POSIX env assignments to `$env:NAME="value"`.
### Verify checklist

- [ ] Stub-fetch proof shows the discovered version on first dispatch, and
  offline/failure uses the pinned fallback; shared Verify block green.

## 3 Schema and routing-setting change


### Goal

Use when adding a Postgres column or per-provider routing setting; done when the value survives from dashboard through snapshot to the dispatch decision with no silent drop.

### Procedure

1. Single-baseline rule: `drizzle/migrations/` holds only `0000_baseline.sql` as an **auto-applied** migration (`test/contracts/migration-integrity.contract.test.ts` asserts the numbered set is exactly that file). Fold the column into the baseline at the same position/order as `src/persistence/schema.ts`, same commit — never add a second auto-applied migration. Hand-run statements for databases already past the baseline live under `drizzle/migrations/manual/` as `NNNN_*.sql`; `applySqlMigrations()` reads only the top level of the migrations folder with a non-recursive `readdirSync` + `/^\d{4}_.+\.sql$/` filter, so that subfolder is never executed by the runner and each file must be applied by hand. Nullable pattern: when null means inherit/unlimited (`max_inflight`, `tenant_id`), omit `.notNull()` and `.default()` — `maxInflight: integer("max_inflight")` on `providerRoutingSettings` is the template.
2. Live databases need a hand-run idempotent `ALTER`, recorded as a new file under `drizzle/migrations/manual/` (connect with `getPool()` from `src/persistence/postgres.ts`; connection string only from `DATABASE_URL`; the ledger `cartethyia_schema_migrations` means `db:migrate` will not re-run the edited baseline):
   ```sql
   ALTER TABLE provider_routing_settings
     ADD COLUMN IF NOT EXISTS max_inflight integer;
   ```
   URL comes from `.env`; docs use placeholders like `<tenant-id>`, never real secrets.
3. Thread every point or the value drops. Backend order: `src/console/providers/catalog/contracts.ts` (`ProviderRoutingResponse` plus `UpdateProviderRoutingRequest`) → `src/transport/routing/route-model.ts` (`RouteCandidate` / `ProviderRoutingSetting` / `ProviderRoutingMap`) → `src/transport/routing/route-catalog.ts` (`RouteCatalogRepository.loadRouteCatalogSnapshot`; precedence account value, then tenant setting, then global `__global__`, then `DEFAULT_PROXY_BYPASS_PROVIDER_IDS`; `null`/`undefined` means unlimited/globally-routable) → `src/console/providers/detail/store.ts` (`DrizzleProviderDetailStore.updateRouting`: extend `values` plus the `setClause` guard `if (patch.x !== undefined)`; `null` clears to unlimited, `undefined` leaves untouched; upsert target `[tenantId, providerId]` or the global partial unique index) → `src/console/providers/detail/routes.ts` (`updateRoutingBody = t.Object({ … })` AND operation validation — Elysia strips unknown keys, so a field missing from either never reaches the store). Prove the consumer read site first (e.g. `src/transport/routing/router.ts` reads `candidate.max_inflight` in `admit`).
4. Dashboard same change: `dashboard/src/lib/contracts.ts` (re-export, no second type source) → `assertProviderRouting` in `dashboard/src/lib/hooks/common.ts` → `dashboard/src/lib/hooks/routing.ts` (`useProviderRouting`, `useUpdateProviderRouting`) and `dashboard/src/lib/use-routing-strategy.ts` (`useRoutingStrategy`, saves via `dashboard/src/lib/use-debounced-save.ts`) → `dashboard/src/routes/provider-detail/RoutingStrategyCard.tsx` (`RoutingStrategyCard`, parity with `dashboard/src/routes/Proxy.tsx`). Backend `updateRouting` calls `await snapshotInvalidator?.invalidate()` so the next `/v1/*` request picks up operator edits; new static columns still need the hand-run `ALTER` plus restart.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/console/providers
bun run test:contracts
bun run scripts/ops-run-tests.ts test/transport/routing
```

### Pitfalls

- Elysia strips unknown keys: store-only additions drop silently with no error — update `t.Object` and validation together.
- `undefined` means "leave untouched", `null` means "clear to unlimited" — swapping them freezes or wipes the value.
- Precedence lives in three places (`route-catalog.ts`, `detail/store.ts` `getRouting`, `resolveTenantOverride`); changing one makes the dashboard disagree with dispatch.
- Missing `snapshotInvalidator.invalidate()` leaves dispatch on the old snapshot while the dashboard shows the new value.

### Verify checklist

- [ ] Round-trip: set via dashboard shape, read back through `getRouting`, confirm `loadRouteCatalogSnapshot` carries it and `router.ts` consumes it; `bun run typecheck`, `bun run dashboard:typecheck`, `bun run test:contracts`; shared Verify block green.

## 4 Console-log field

### Goal

Use when adding a field to the Console Log line; done when the value flows from dispatch to the SSE tail to the dashboard row with no missing layer.

### Procedure

1. Source is `pushStructuredConsoleLog` in `src/observability/log-ring.ts` (`ConsoleLogLine`, `ConsoleLogMetadata`, ring `CAPACITY = 500`, `getConsoleLogSnapshot` / `subscribeConsoleLogs`). Add the optional key to BOTH interfaces or it never emits.
2. Thread the backend chain in order: `src/transport/routing/route-model.ts` (`RouteCandidate`, by reference, never serialized) → `src/transport/request/state.ts` (`ProxyRequestOutcome`: outcome `status` is the internal terminal state, `httpStatus` its wire projection) → `src/transport/dispatch/attempt-finalize.ts` (`AttemptCompletion extends ProxyRequestOutcome`; `completeAttempt` copies each field via explicit `=== undefined ? {} : {…}` spreads — an unspread field vanishes even when passed; terminal-only capture plus `finalizeRequestTelemetry` run only when `terminal: true` under the `state.completed` idempotency guard, one telemetry row per request) → every `completeAttempt(…)` site in `src/transport/dispatch/proxy-request.ts` that knows the value (grep it — five sites at time of writing across `runAttemptLoop` and terminal settle paths) → finalize emit in `src/transport/middleware/ingress.ts` (`finalizeRequestTelemetry` spreads `state.outcome` plus `model` from the canonical request and `routedModel` from `preparedRequest.plan`; `request_complete` vs `request_error`; `request_start` emitted separately; non-dispatch `/v1` routes like `/v1/models` return early via `isProxyDispatchRoute`). Transport `src/console/domains/logs.ts` serves snapshot plus SSE (`src/console/domains/sse/routes.ts`); nothing touches the database.
3. Dashboard: extend `ConsoleLogLine` in `dashboard/src/lib/hooks/logs.ts`, add the field to the search haystack and `LogRow` in `dashboard/src/routes/ConsoleLog.tsx` (single-line row, `title` plus ellipsis for long values).
4. Labels, not secrets: log `accountLabel`, never credential material; never enrich via a dashboard-side account lookup — thread from the backend candidate; network pools are the one exception via `useNetworkPools()`.
5. The ring is an in-memory SSE tail — restarts clear it by design. Backend emit changes need an operator restart; pure display changes need only `dashboard:build` plus reload.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/observability
bun run scripts/ops-run-tests.ts test/transport/middleware
bun run dashboard:test
```

### Pitfalls

- The missing `completeAttempt` spread is the classic silent drop: caller passes it, the type allows it, the line stays empty.
- `state.completed` idempotency means fields set after terminal completion never render — set them before the terminal call.
- Dashboard `isLogLine` drops malformed `ts`/`level`/`msg`; a backend rename without the dashboard type update blanks the whole tail.
- Flood-prone warns must throttle (once per minute per key, like the preparer degrade warn) or they push real lines out of the bounded ring.

### Verify checklist

- [ ] Stub-adapter dispatch shows the field on the snapshot line and the dashboard haystack matches it; both typechecks; shared Verify block green.

## 5 Change gate and commit

### Goal

Use when the change is ready to land; done when every gate passes from a clean tree and history is split, documented, and never pushed unasked.

### Procedure

1. Gates from the root, escalating as needed: `bun run typecheck` → `bun run dashboard:typecheck` → `bun run test` → `bun run dashboard:test` → `bun run build` (`dashboard:build`, then `build:aot`, then `bun build --compile --minify --target bun src/main.ts --outfile dist/cartethyia`). Deeper: `bun run test:contracts`, `bun run test:integration` (needs `CARTETHYIA_TEST_DATABASE_URL`), `bun run check:coverage` (floor 75% via `scripts/ci-check-coverage.ts`; `COVERAGE_MIN=80.0` in DB-backed CI). Focused loop: `bun run scripts/ops-run-tests.ts <dir>` (thin `bun test --timeout 60000` wrapper pinning `CARTETHYIA_ENCRYPTION_KEY`).
2. Changelog in the same change under `## Unreleased` in `CHANGELOG.md` — backend, provider, and dashboard bullets each.
3. Split commits backend vs dashboard (`type(scope): …`), each ending with `Co-Authored-By: Claude Mythos 5 <noreply@anthropic.com>`. Never push to `origin` unasked. Restart the built binary after landing when runtime behavior changed.
4. Strays: `git status --short` shows only intended paths; `.env*` stays untracked except `.env.example`.
5. Constraints: schema plus baseline same commit; keep `await import()` lazy in `default-registry.ts`; explicit exported types, `import type` for types, no `index.ts` barrels; `quota_exhausted` eligibility maps to account `cooldown`; `await snapshotInvalidator?.invalidate()` after writes in `detail/routes.ts`, `catalog/routes.ts`, `oauth/routes.ts` (plus pool/model mutating contracts).
6. TSX: typecheck immediately after structural cut-or-paste (over-deletion is silent); unused imports are typecheck's call; no screenshot daemon — the operator verifies visually. Test doubles mirror the full field set on create plus update, then mutation-test by deleting the field from the double and confirming failure.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run test
bun run dashboard:test
bun run test:contracts
bun run test:integration
bun run check:coverage
bun run dashboard:build
bun run build
git status --short
```

### Pitfalls

- Zero-fail with no pinned counts: baseline BEFORE the change; a lone `1 fail` vanishing on re-run is parallel-load flake — second run, then bisect by directory.
- DB-gated suites (`test/helpers/db-gate.ts`) skip without a database — report skips separately, never as green.
- Build order: `dashboard:build` before `bun run build` (the server embeds `dist/`). Windows docs use POSIX `bun run …`; PowerShell env form is `$env:NAME="value"`. Never `find | xargs` in instructions.

### Verify checklist

- [ ] Full gates green (or scoped with stated reason plus focused suite), changelog updated, commits split, no strays; shared Verify block green.

## 6 Feature removal

### Goal

Use when deleting a whole feature cluster; done when no fallback, shim, or dead code remains and the report states what was deliberately not cut.

### Procedure

1. Measure import edges, not LOC: dependents are files OUTSIDE the cluster importing INTO it. Table `candidate | files | LOC | prod dependents | test dependents` via case-insensitive grep across `src`, `test`, `scripts`, `dashboard/src`, `Dockerfile`, `package.json`, `README.md`, verifying every hit path-qualified (false positives abound). The owner picks scope from this table.
2. Cut in order, staying compilable: composition root (`src/app.ts`, `src/runtime/dependencies.ts`, console domain registration) → config (`src/config.ts`, `.env.example`) → registration (`default-registry.ts`, console routes) → modules (integrations, quota/discovery/operations) → schema (`src/persistence/schema.ts` plus `0000_baseline.sql` same commit) → tests (`test/` mirroring `src/`) → dashboard (routes, hooks, `dashboard/src/lib/contracts.ts`) → `scripts/`, `Dockerfile`, `package.json`. Typecheck after EACH cluster (plus `dashboard:typecheck` when the dashboard moved). Files over half affected get rewritten. Confirm `.tsx` range bounds (first/last kept lines) before deleting.
3. Schema pins: `test/contracts/migration-integrity.contract.test.ts` pins `network_pools` columns/indexes/checks and asserts the baseline carries no orphan `backup_status` table; `test/integration/isolated-db.test.ts` compares a freshly migrated database against `schema.ts` column by column — update migration assertions, the fixture, and schema together.
4. Report what was NOT cut and why (shared helper, facade, sub-union) with the deleted-path listing plus a post-cut keyword sweep. Edit tangled `.tsx` directly, never via subagent, typecheck immediately. Update `toHaveLength(N)` count assertions in the cut commit.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/console
bun run test:contracts
```

### Pitfalls

- Hiding a control (`false` flag, commented route) instead of deleting it leaves dead code — delete registration, module, and test.
- Cutting modules before the composition root breaks every intermediate step; follow the order.
- `dashboard/src` copies are not dead on arrival — grep it separately before declaring a backend symbol unreferenced.
- `generated/` protobuf looks hand-written but is not; trace its importer before dropping.

### Verify checklist

- [ ] Edge table shown, per-cluster typechecks, pins updated, NOT-cut list with reasons, keyword sweep clean; shared Verify block green.

## 7 Safe removal and measurement

### Goal

Use when deleting files, measuring a tree, or checking who reads a path; done when fresh numbers plus a reader list prove the deletion safe.

### Procedure

1. Measure with Python `os.walk` — never `find | xargs` (Windows PowerShell). Re-measure at deletion time, skip `generated/`, count `.ts` vs `.test.ts` separately, `encoding="utf-8", errors="ignore"`:
   ```python
   import os
   SKIP = {"node_modules", ".git", "dist", "generated"}
   for root, dirs, files in os.walk("src/providers/integrations/buddy"):
       dirs[:] = [d for d in dirs if d not in SKIP]
       ts = [f for f in files if f.endswith(".ts") and not f.endswith(".test.ts")]
       tests = [f for f in files if f.endswith(".test.ts")]
       print(root, len(ts), len(tests))
   ```
2. Trace readers BEFORE deleting across `src`, `test`, `scripts`, `dashboard`, `package.json`, `Dockerfile`, `*.sh`, `*.yml` (flat files plus nested dirs). Generated output under `src/providers/integrations/…/generated/` drops only with its importer. Confirm hits with word-boundary `Grep` on the exact symbol.
3. Critical path: typecheck is `tsc --noEmit`; build is `dashboard:build && build:aot && bun build --compile --minify --target bun src/main.ts`; tests go through `scripts/ops-run-tests.ts`; `scripts/` is flat (no `scripts/ops/`).
4. `git ls-files <path>` decides tracked vs ignored; removing a path Docker or the build reads means removing that reader in the same change. `git diff --stat` must match expectations — no silent extras, no missing halves.

```bash
git ls-files src/providers/integrations/buddy
git status --short
git diff --stat
bun run typecheck
bun run dashboard:typecheck
```

### Pitfalls

- `git status` omits ignored build output (`dist/`, `coverage/`); `git ls-files` is the arbiter.
- Reader tracing that skips `dashboard/src` misses `../../../src/…` backend-contract imports.
- `generated/` skews LOC counts — exclude it from measurement and include its importers in tracing.
- Stale numbers are fiction; re-measure in the deletion commit.

### Verify checklist

- [ ] Fresh `os.walk` numbers, full reader list including `generated/` importers, `git ls-files` plus `diff --stat` consistent; shared Verify block green.

## 8 Compat shims

### Goal

Use when a refactor left re-exports or type aliases behind; done when dead shims are gone, live consumers repointed, and only genuine sub-unions or untouched facades remain.

### Procedure

1. Enumerate: grep `^export \{` and `^export type \{` across `src/`, narrow via `git diff HEAD -- src/` plus per-file `export|Backward|compat` scan.
2. Classify: dead (zero consumers — delete), live (repoint every consumer to the canonical symbol, then delete), genuine (real sub-union, narrowed alias, or untouched console facade — keep with a one-line reason).
3. Map consumers with word boundaries — `\bSymbolName\b` over `src/`, `test/`, `dashboard/src/` (`.ts` plus `.tsx`); include the defining file's own internal use. Repoint dashboard relative imports (`../../../src/…`, e.g. `dashboard/src/lib/contracts.ts`) to the canonical module, preferring top-level `import type`.
4. Blanket-rename guard: a rename producing a self-reference (`export type New = New`) is always wrong — delete those lines explicitly. Delete shims after repointing, then run both typechecks; green backend plus red dashboard means a dashboard relative import still points at the old name.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/console
bun run scripts/ops-run-tests.ts test/transport
```

### Pitfalls

- Substring grep (`Old` matching `OldV2`) invents consumers — always `\b` boundaries.
- Dashboard-only consumers are invisible to backend-only tracing; the dashboard tree is mandatory.
- Deleting a live shim before repointing breaks every consumer at once; repoint-then-delete stays green.
- Console facades imported for route mounting (`domain-registration.ts`, `console-router.ts`) are load-bearing — confirm the mount chain before calling one dead.

### Verify checklist

- [ ] Enumeration query shown, each shim classified with consumer lists, dashboard imports repointed, no self-references, both typechecks green; shared Verify block green.

## 9 Consolidating duplication

### Goal

Use when the same rule, guard, formatter, or envelope appears in several places; done when exactly one module owns it, every caller reads that owner, and the copies are gone.

### Procedure

1. **Diff before believing.** Two functions that "look the same" usually are not. Extract the bodies and `diff` them (or hash them) before planning a merge: four `formatBytes` copies turned out to disagree on the unit threshold, the decimal count *and* the placeholder, so "dedupe" was really a behaviour decision. Identical bodies can merge mechanically; divergent ones need the owner chosen and the losing policy stated.
2. **Name the owner by layering, not by call-site count.** The lower layer that both sides can already import owns the helper. A guard used 169 times against a copy used 41 times still moves *down*, not sideways: `protocol/primitives` was the right home for `isRecord` because `transport/surface` already imports from `protocol`, and having `protocol` import the guard from `surface` was a cycle across layers.
3. **Consolidate the caller shape too, not only the helper.** Eleven handlers opened with the same six-line access block, 95 with the same `try/catch` wrapper. The win is deleting the repetition at the call site — a helper plus eleven copies of the boilerplate is not consolidation. For a repeated wrapper, look for a framework-level hook (Elysia's global `error(handler)`) before writing a per-call helper.
4. **Migrate in one pass, then delete.** Repoint every caller, then remove the copy. Typecheck between the two is what catches the call site you missed; a repo-wide rename script that also rewrites strings or unrelated identifiers will corrupt files, so verify the script's output per file rather than trusting a count.
5. **Re-verify behaviour, not just the typecheck.** A merged guard must still reject what the strictest original rejected. Where the merge changes a *number* (a query count, an allocation), assert the invariant the test actually cares about instead of the implementation detail that moved.
6. **Keep the deliberate divergence.** Two things that resemble each other but encode different protocol behaviour stay separate, with a comment saying so. `chat`/`completion` share an SSE frame shape; `responses`/`messages` do not, because one carries a `[DONE]` sentinel and a wire-derived event name.

```bash
bun run typecheck
bun run scripts/ops-run-tests.ts test/<area>
bun run test:contracts
```

### Pitfalls

- Merging identical-looking bodies that differ in a throw path, a default, or a wire shape silently changes behaviour. Diff first.
- A guard (`typeof x === "function"`, a capability probe) can be load-bearing for a partially-implemented test double even when production always takes the same arm. Removing it can change how many queries run; the experiment is a typecheck plus the affected suite, not an argument.
- Deleting a copy while a caller still imports it through a re-export or a relative dashboard path breaks both trees differently — run `dashboard:typecheck` too.
- Two files with the same basename (`adapter.ts`) collide in any temp-file scheme (`/tmp/<basename>.keep`). Key backups by full path, or a bisect step will overwrite one file with the other.
- A helper that returns a loose type (`Record<string, unknown>`) makes every spread site lose the fields the callee requires. Type it against the destination shape.
- Rebuilding a lookup table inside the function that reads it (three `Record`s per rejection) is duplication's cost on the hot path — hoist it to module scope.

### Verify checklist

- [ ] Bodies diffed (identical vs divergent recorded), owner named with its layer, every caller migrated, copies deleted, deliberate divergences kept with a reason, both typechecks and the affected suites green; shared Verify block green.

## Verify

```bash
bun run typecheck
bun run test                          # focused: bun run scripts/ops-run-tests.ts <dir>
bun run test:contracts
bun run test:integration              # needs a database URL
bun run dashboard:typecheck           # whenever dashboard/ or route contracts touched
bun run dashboard:test                # whenever dashboard/ touched
bun run dashboard:build               # whenever dashboard/ touched, before bun run build
```

0 fail always (never pin pass counts); diff against the pre-change baseline captured BEFORE the change. Lone `1 fail` vanishing on re-run is parallel-load flake — second run, then bisect by directory. DB-gated suites (`test/helpers/db-gate.ts`) skip without a database — report skips separately. Coverage floor 75% (`scripts/ci-check-coverage.ts`) via `check:coverage` when at risk.
