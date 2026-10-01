# Contributing to Cartethyia

Setup, workflow, and PR checks. Human-facing companion to `AGENTS.md` (agent rules) and `ARCHITECTURE.md` (code map) — authoritative for their topics, linked not duplicated.

## Prerequisites

- Bun 1.4.2 (see `.bun-version`; Docker pins `oven/bun:1.4.2-debian`)
- PostgreSQL (external in native setups; the Compose stack supplies one for Docker)
- Redis for `REDIS_MODE=normal`; optional for `REDIS_MODE=single_instance_local`
- A Node-compatible environment for tooling

## Local setup

```bash
bun install
cp .env.example .env
# Edit DATABASE_URL and CARTETHYIA_ENCRYPTION_KEY in .env.
bun run setup     # copies .env if missing, probes Postgres/Redis (the backend migrates at boot)
bun run doctor    # re-checks the environment and /health/ready
bun run dev       # backend (bun --hot) + dashboard (Vite) under concurrently
```

Useful endpoints once running (`http://localhost:12800` by default):

```text
/health        liveness
/health/ready  readiness (DB + migrations + Redis)
/metrics       Prometheus metrics
/v1/*          gateway APIs
/console       dashboard
```

`bun run dev:backend` and `bun run dashboard:dev` run each half separately.
`bun run dev` runs both under `concurrently`: backend `bun run --hot src/main.ts` on `PORT` (default 12800), dashboard Vite dev server on 5173. No supervisor, no in-place restart — a client hitting the backend mid-restart sees a refused connection. **CTRL+C** stops both.
`VITE_BACKEND_URL` (see `.env.example`) points Vite at the backend. Production serving: `README.md` (Docker Compose).

## Running tests

DB suites gate on `CARTETHYIA_TEST_DATABASE_URL` at an **isolated** Postgres DB (`test/helpers/db-gate.ts`): set → they run; unset → they skip with `[db-gate] skipped`. The same helper repoints the process at that database (`getDb()` resolves `DATABASE_URL`, the gate overwrites it before any pool opens) — a DB suite never touches your working database, no manual URL alignment needed. Skips are expected locally; report them separately from failures.

```bash
bun run test:fast            # backend without integration trees (local iteration)
bun run test                 # full backend suite (DB suites skip without the URL)
bun run test:contracts       # cross-cutting contract suites
bun run test:integration     # integration suites
bun run check:coverage       # coverage gate: 85% line coverage over src/

bun run scripts/ops-run-tests.ts test/console                     # one subtree
bun run scripts/ops-run-tests.ts test/providers/integrations/codex

bun run dashboard:test        # generate usage-periods once, then dashboard suite
```

## Verification gate (before every PR)

Backend change (from `AGENTS.md`):

```bash
bun run typecheck
bun run test
bun run check:coverage
```

Dashboard or API-contract change, additionally:

```bash
bun run dashboard:typecheck
bun run dashboard:test
bun run test:contracts
```

CI (`.github/workflows/ci.yml`) runs exactly these gates with Postgres +
Redis services and the same `COVERAGE_MIN=85` floor. Typecheck and build never
require Buf, vendor protobuf sources, or network access.

## Code conventions (short version)

Full rules in `AGENTS.md`. What bites new contributors most:

- `src/` production only — no `*.test.ts`; tests in `test/` mirroring `src/`.
- No `index.ts` barrels; concrete files. `import type` for types. Strict TS: no `any`, no suppressions, no needless assertions; `unknown` + narrowing at boundaries.
- Entity dirs use role filenames: `contracts.ts` (types + validation + operations + routes), `routes.ts`, `store.ts`, `service.ts`, `errors.ts`.
- `scripts/` flat, `ops-*` / `build-*` / `ci-*` prefixes.
- Comments explain policy, security, non-obvious tradeoffs — not the next line.
- Tests assert observable behavior, boundaries, errors, transitions, security invariants — never implementation details or source text (except layout/config contracts like `test/architecture/`).
- Never delete a test for being old or moved; replace lost contract coverage when you remove one.

- One layer doc per top-level `src/` folder beside it, named for the layer (`src/transport/TRANSPORT.md`) — subfolders carry none; `ARCHITECTURE.md` is only the map. A new layer, route group, provider capability, env var, or DB table updates the matching top-level doc (plus `.env.example` for env vars, `migrations/` + `schema.ts` for tables). Adding/renaming a top-level folder doc also updates the `ARCHITECTURE.md` table.
- `README.md` + `.env.example` product/runtime; `AGENTS.md` agent rules; `CHANGELOG.md` entries under `Unreleased` stay historical once written. Keep all four in sync with the source you change.
- Doc-drift rules (what changes together, what never goes in docs, code-vs-docs conflicts) live in `AGENTS.md` "Docs are part of the change" — read it before touching any doc. Update docs your change made wrong; don't rewrite a layer doc you weren't working in.

## Pull requests

- Branch from `main`, keep the change focused, remove callers in the same
  change (no compat shims — see `AGENTS.md` "Clean cutover, no aliases").
- Fill in `.github/pull_request_template.md`: what changed, gates run, DB-gated skips vs failures, docs updated.
- Every privileged console mutation ends with audit + route-snapshot
  invalidation; every security layer stays fail-closed; telemetry stays
  metadata-only and best-effort. Layer docs (via the `ARCHITECTURE.md` map)
  state each invariant where it applies.
