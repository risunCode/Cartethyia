# Cartethyia Architecture

Self-hosted AI gateway (Bun + TypeScript + Elysia + PostgreSQL, Redis
optional). It accepts several client protocols, normalizes them into one
canonical model, routes across provider accounts and models with admission
and capability checks, and dispatches through SSRF-validated direct egress
or pooled HTTP/SOCKS5 proxies. The same process serves the React dashboard.

This file is only the map: how to read the docs, the big picture, and where
each layer lives. Implementation detail lives in the per-folder docs linked
below — each layer doc sits beside the code it describes, named for its layer.

## How to read the docs

- Start here for orientation, then open the doc for the top-level folder you
  need. Each has the same shape: purpose, layout, key behaviors with concrete
  file/function names, invariants, and a "How to extend" checklist.
- One doc per top-level `src/` folder, covering its whole subtree, named for its
  layer in caps (`src/providers/PROVIDERS.md`, `src/transport/TRANSPORT.md`) so
  no two docs share a basename. Subfolders carry no doc of their own — the
  parent absorbs them, so `src/providers/PROVIDERS.md` also covers
  `integrations/`, `operations/`, `authentication/`, `quota/`, and
  `discovery/`, and likewise for the other big subtrees.
- Product usage and runtime configuration stay in `README.md` and
  `.env.example`. Agent-only repo rules stay in `AGENTS.md`.

## Big picture

Two planes share one process (`src/main.ts` → `bootstrap()` in
`src/runtime/lifecycle.ts` → `buildProductionDeps()` in
`src/runtime/dependencies.ts` → `createGatewayApp()` in
`src/app.ts`):

- **Data plane** — `/v1/*` inference traffic: transport (pipeline, routing,
  dispatch) → protocol codecs → provider adapters → network egress, guarded
  by security layers and recorded by observability.
- **Control plane** — `/console/api/*` dashboard API plus the public
  `/share/*` surface: operator mutations with per-tenant access checks,
  audit rows, and route-snapshot invalidation so the next `/v1/*` request
  picks up changes without a restart.

`src/app.ts` exposes a single builder, `createGatewayApp(deps)`, whose `mode`
discriminant selects how much of the process mounts:

- `{ mode: "production", … }` — the full process, both planes above.
- `createGatewayShell(options)` — route-only: dashboard, `/health`, and
  `/metrics`, with no transport pipeline and no console router. Two consumers
  depend on it, so it is not a spare path: `bun run build:aot` captures the
  Elysia manifest by running `src/main.ts` with `Manifest.isCapturing()` true,
  where `bootstrap()` is skipped and no database exists, and the routing /
  static-serving tests need the console router to be absent.

One request, end to end: ingress (single body read) → ordered pipeline
(readiness → identity → IP-abuse → API-key auth → canonical parse → route
prepare) → `RoutingEngine.plan()` (alias → combo → ambiguity → eligibility
→ capability filter → provider-routing reorder) → leases (admission →
pool slot → reservation) → provider adapter dispatch (stream primed before
the 200 commits) → `completeAttempt()` (usage, health, capture, exactly one
telemetry row).

## Doc map

### Data plane

| Layer | Doc | Covers |
|---|---|---|
| transport | `src/transport/TRANSPORT.md` | Canonical core, lifecycle, ingress pipeline, surface codecs, preparation/state, capability/alias/combo, routing plan, dispatch, error taxonomy |
| protocol | `src/protocol/PROTOCOL.md` | Canonical↔wire codecs, registry dispatcher, shared primitives |
| network | `src/network/NETWORK.md` | Validated egress, SSRF policy, HTTP/2, pool agents, weighted admission, retry/dedup rules |
| security | `src/security/SECURITY.md` | Identity → auth → CSRF → IP-abuse → admission, crypto, headers |
| providers | `src/providers/PROVIDERS.md` | Registry, metadata × capabilities × lazy import, seeding/catalog/discovery, OAuth kit, quota shape and window engine, per-provider adapters, runtime operations |

### Control plane

| Layer | Doc | Covers |
|---|---|---|
| console | `src/console/CONSOLE.md` | Conventions, cookie auth and first-boot, catalog and accounts, alias/combo and pools, domains and Studio, CLI tools, quota views, runtime settings, backup/restore and router-export import, share pages ([injector contract](src/console/cli-tools/injectors/CONTRACT.md)) |

### Foundation

| Layer | Doc | Covers |
|---|---|---|
| persistence | `src/persistence/PERSISTENCE.md` | Schema groups, pool singletons, migration ledger, stores |
| runtime | `src/runtime/RUNTIME.md` | Boot order, shutdown stages, timeout/backoff/TTL-cache |
| observability | `src/observability/OBSERVABILITY.md` | Telemetry pipeline, logger, metrics, payloads, gauges |
| workers | `src/workers/WORKERS.md` | Scheduler semantics, task table, OAuth + quota sweeps |

## Other trees (not covered by layer docs)

- `dashboard/` — React/Vite console, landing, and share apps. Its map and
  browser-safe import rules live in `dashboard/README.md`.
- `test/` — backend tests mirroring `src/`, plus `contracts`, `integration`,
  `architecture` (naming contracts), `frontend`, `helpers`; loose root files
  such as `config.test.ts` and `config-env-drift.test.ts` cover cross-cutting
  config contracts.
- `scripts/` — flat operational scripts (`ops-*`, `build-*`, `ci-*`).
- `drizzle/migrations/` — `0000_baseline.sql` is the only auto-applied file;
  `applySqlMigrations` reads numbered `NNNN_*.sql` files from that folder's
  top level (non-recursive) and records each in
  `cartethyia_schema_migrations`. `drizzle/migrations/manual/` holds
  hand-run statements kept as a record of what a database created from an
  older baseline still needs; the ledger runner never reads that subfolder.
  Committed protobuf output lives under the provider integrations that
  consume it (`src/providers/integrations/*/generated/`).

## Conventions (short version)

- `src/` is production code only, no `*.test.ts`. No `index.ts` barrels —
  import concrete files. `import type` for type-only imports.
- Entity directories use role filenames: `contracts.ts` (types + validation
  + operations + routes), `routes.ts`, `store.ts`, `service.ts`, `errors.ts`.
- Console writes end with audit + snapshot invalidation. Telemetry is
  metadata-only and best-effort — it never blocks or throws into requests.
- Every security layer is fail-closed: store outages reject, never bypass.
- Details in each layer doc; this file intentionally does not duplicate them.
