# Contributing to Cartethyia

Setup, workflow, and the checks your pull request must pass. This is the
human-facing companion to `AGENTS.md` (agent repo rules) and `ARCHITECTURE.md`
(code map) — those stay authoritative for their topics and are linked, not
duplicated, below.

## Prerequisites

- Bun 1.4.2 (see `.bun-version`; Docker pins `oven/bun:1.4.2-debian`)
- PostgreSQL (external in every mode — native and Docker alike)
- Redis for `REDIS_MODE=normal`; optional for `REDIS_MODE=single_instance_local`
- A Node-compatible environment for tooling

## Local setup

```bash
bun install
cp .env.example .env
# Edit DATABASE_URL and CARTETHYIA_ENCRYPTION_KEY in .env.
bun run setup     # copies .env if missing, probes Postgres/Redis, runs migrations
bun run doctor    # re-checks the environment and /health/ready
bun run dev       # supervisor proxy + backend (bun --hot) + dashboard (Vite); CTRL+R = restart in place
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
`bun run dev` itself is a supervisor (`scripts/ops-dev-supervisor.ts`): it
binds the public port and reverse-proxies to the backend on an internal port,
so **CTRL+R** restarts the whole stack in place while incoming requests are
held until the backend is back — clients see latency, never a refused
connection. **CTRL+C** stops everything; `bun run dev:stack` runs the raw
stack without the supervisor. Advanced knobs (`DEV_PROXY_PORT`,
`DEV_BACKEND_PORT`, `DEV_SUPERVISOR_CMD`, `DEV_HOLD_MS`) are documented in
the script header.
`VITE_BACKEND_URL` (see `.env.example`) points the Vite dev server at the
backend. Production serving is covered in `README.md` (Docker Compose).

## Running tests

DB-dependent suites gate on `CARTETHYIA_TEST_DATABASE_URL` pointing at an
**isolated** Postgres database (`test/helpers/db-gate.ts`): with the variable
set they run, without it they skip with a `[db-gate] skipped` note. The same
helper also routes the process at that database, because `getDb()` resolves
`DATABASE_URL` — the gate overwrites it before any pool is opened. A DB suite
therefore never touches your working database, and you do not need to align
`DATABASE_URL` with the test URL by hand. Skips are expected locally — report
them separately from failures in your PR.

```bash
bun run test                 # full backend suite (DB suites skip without the URL)
bun run test:contracts       # cross-cutting contract suites
bun run test:integration     # integration suites
bun run check:coverage       # coverage gate: 75% offline, COVERAGE_MIN=80 with DB

bun run scripts/ops-run-tests.ts test/console                     # one subtree
bun run scripts/ops-run-tests.ts test/providers/integrations/codex

bun run dashboard:test        # dashboard (Vitest/bun) suite
```

## Verification gate (required before every PR)

From `AGENTS.md` — backend change:

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
Redis services and `COVERAGE_MIN=80`. Typecheck and build never require Buf,
vendor protobuf sources, or network access.

## Code conventions (short version)

Full rules live in `AGENTS.md`. The points that most often bite new
contributors:

- `src/` is production code only — no `*.test.ts` there; tests live in
  `test/` mirroring `src/`.
- No `index.ts` barrels; import concrete files. `import type` for type-only
  imports. Strict TypeScript: no `any`, no suppression directives, no
  needless assertions; prefer `unknown` + narrowing at boundaries.
- Entity directories use role filenames: `contracts.ts` (types + validation
  + operations + routes), `routes.ts`, `store.ts`, `service.ts`, `errors.ts`.
- `scripts/` is flat with role prefixes (`ops-*`, `build-*`, `ci-*`).
- Comments explain policy, security, or non-obvious tradeoffs — not what the
  next line does.
- Tests assert observable behavior, boundaries, errors, transitions, or
  security invariants — never implementation details or source text (unless
  the contract is about a layout/config rule, like `test/architecture/`).
- Never delete a test just because it is old or moved; replace lost contract
  coverage when you remove one.

- Each top-level `src/` folder documents its whole subtree in one layer doc
  beside it, named for the layer (`src/transport/TRANSPORT.md`) — subfolders do
  not carry their own; `ARCHITECTURE.md` is only the map linking to them. If your change adds a layer, route group, provider
  capability, env var, or DB table, update the corresponding top-level doc
  (and `.env.example` for env vars, `drizzle/` + `src/persistence/schema.ts`
  for tables). Adding or renaming a top-level folder doc also updates the
  `ARCHITECTURE.md` table.
- `README.md` + `.env.example` are product/runtime docs; `AGENTS.md` is
  agent-only rules; `CHANGELOG.md` entries under `Unreleased` stay historical
  once written. Keep all four synchronized with the source you change.
- Anti-drift rules (what must change together, what must never be recorded
  in docs, and what to do when doc and code disagree) live in
  `AGENTS.md` under "Documentation and configuration currency" — read that
  section before touching any doc.

## Pull requests

- Branch from `main`, keep the change focused, remove callers in the same
  change (no compatibility shims — see `AGENTS.md` cleanup rules).
- Fill in `.github/pull_request_template.md`: what changed, which gates you
  ran, DB-gated skips vs failures, and which docs you updated.
- Every privileged console mutation must end with audit + route-snapshot
  invalidation; every security layer stays fail-closed; telemetry stays
  metadata-only and best-effort. The layer docs (`ARCHITECTURE.md` map)
  explain each invariant where it applies.
