# ![](orca-paste-1790786723417-099ae9d3-f3a2-4dac-9c24-74887febf6fa.png)Cartethyia

<img width="1760" height="576" alt="Cartethyia banner" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

**A self-hosted AI gateway that speaks every client protocol and every provider
dialect — so you configure a route once, and any client can reach any model.**

Cartethyia sits between your AI clients and your provider accounts. It accepts
the wire formats real tools already speak, normalizes every one of them into a
single canonical request, then routes that request across provider accounts and
models under admission control, capability checks, health tracking, and
validated egress.

The result is one endpoint, one key, one dashboard. Point Claude Code, Codex,
or any OpenAI-compatible client at it, and let the gateway work out which
account serves the request, whether the provider can express what the client
asked for, and what to do when it cannot.

Built with Bun, TypeScript, Elysia, PostgreSQL, and optional Redis coordination.

## Highlights

- **Bundled provider integrations** — OpenAI, Anthropic, Codex, Gemini, Grok,
  xAI Grok Subscription, Devin, Mistral, OpenRouter, Cerebras, NVIDIA,
  DeepSeek-family gateways, and more, each with its own authentication, wire
  quirks, and identity headers. The set is declared once in
  `src/providers/provider-metadata.ts`; mirrors (registry, capabilities, dashboard
  names and icons) are synchronized consumers, so no document pins a count.
- **Four client protocols, one canonical model** — Chat Completions, Responses,
  Messages, and legacy Completions all normalize into the same request shape.
  A client's protocol is a property of the connection, not of the route.
- **Capability-aware routing that translates instead of rejecting** — when a
  chosen model cannot express something the client asked for, the request is
  degraded in place (generation controls dropped, media replaced by placeholders)
  rather than silently rerouted to a model you never asked for.
- **Account health as a state machine** — every failure is classified into
  `active` / `cooldown` / `disabled`, with per-account and per-model
  backoffs, automatic recovery, and a full transition log you can read.
- **Validated egress pools** — HTTP CONNECT, HTTPS CONNECT, and SOCKS5, with
  SSRF validation at both creation and connection time. Configured pool failures
  surface as failures; a request never silently falls back to direct egress.
- **Multi-tenant by construction** — scoped personal API keys, non-authenticating
  share templates that enroll one child per trusted client IP, model allow/deny
  policies, per-key rate and token budgets, and a per-key list of refused client
  routers (a best-effort header label, not an authentication boundary).
- **Observability you can act on** — per-request telemetry, bounded and redacted
  payload capture, Prometheus metrics, a live console log, and JSON export /
  import for moving configuration between deployments.

## Supported client protocols

Each surface below has a real handler, codec, and test suite behind it. The
gateway accepts a client's own wire format and normalizes it — the protocol is a
property of the connection, not of the route you configure.

| Surface | Path | Notes |
|---|---|---|
| Chat Completions | `/v1/chat/completions` | The broadest compatibility surface |
| Responses | `/v1/responses` | Native for Codex; reasoning, tools, hosted tools |
| Responses compact | `/v1/responses/compact` | Native Codex compaction |
| Messages | `/v1/messages` | Anthropic-native; what Claude Code speaks |
| Completions | `/v1/completions` | Legacy text completion |
| Models | `/v1/models` | Read-only catalog listing (`/v1/models/info` for detail) |
| Web Search | `/v1/search` | Native search route; bundled Exa/Tavily/Brave providers |
| System One | `/v1/systemone` | Native decision route (`{state, questions}` → `{answers}`) |


## Request lifecycle

Every request walks the same path, which is what makes the behavior predictable:

```text
ingress (single body read)
  → ordered pipeline (readiness → identity → IP-abuse → API-key auth
                      → canonical parse → route prepare)
  → plan (alias → combo → ambiguity → eligibility → capability filter
          → provider-routing reorder)
  → leases (admission → pool slot → reservation)
  → provider adapter dispatch (stream primed before the 200 commits)
  → completeAttempt (usage, health, capture, exactly one telemetry row)
```

Routing, admission, retry, accounting, and telemetry are shared across every
surface — a `/v1/messages` request and a `/v1/chat/completions` request travel the
same path once they are canonical.

## Requirements

- Bun 1.4.2
- PostgreSQL
- Redis for `REDIS_MODE=normal`
- Node-compatible development environment for tooling

PostgreSQL is external in native setups, or supplied by the Compose stack in
Docker. Redis is optional when using `REDIS_MODE=single_instance_local`.

## Quick start

```bash
bun install
cp .env.example .env
# Edit DATABASE_URL and CARTETHYIA_ENCRYPTION_KEY.
bun run setup
bun run dev
```

The backend listens on `http://localhost:12800` by default. The dashboard is
served by the same application in production mode.

`bun run dev` runs the backend and the Vite dev server side by side under
`concurrently`: the backend is `bun run --hot src/main.ts` on `PORT` (default
12800), and the dashboard is on port 5173. There is no supervisor proxy and no
in-place restart — a client that reaches the backend while it is restarting sees
`connection refused`. **CTRL+C** stops both processes.

Useful endpoints:

```text
/health       liveness
/health/ready readiness
/metrics      Prometheus metrics
/v1/*         gateway APIs
/console      dashboard
/share/:token public child-key enrollment
```

## Dashboard

The console is served from the same application and covers the whole operational
surface:

- **Overview** — traffic, success rate, latency, and provider health at a glance
- **Usage** — per-request telemetry with request detail and payload inspection
- **Providers** — accounts, credentials, health, per-account in-flight limits,
  today/lifetime token usage, and per-model probing. Built-in API-key providers
  can configure the upstream User-Agent in Routing Strategy; OAuth identities
  and custom-provider client choices remain unchanged.
- **Model Lab** — exercise a model directly and see the raw exchange
- **Combos & Routes** — model combos, aliases, and CLI-tool mappings
- **Quota Management** — account quota, check-in state, and refresh control
- **Proxy & Requests** — egress pools, reachability tests, and dispatch history
- **CLI Tools** — map a coding agent's model slots onto your own routes
- **Customization, Console Log, Settings** — runtime configuration, live logs,
  and backup/restore

## Configuration

`.env.example` is the configuration reference. Required values for a real run:

```text
DATABASE_URL
CARTETHYIA_ENCRYPTION_KEY
CARTETHYIA_PUBLIC_ORIGIN
REDIS_URL                    # unless REDIS_MODE=single_instance_local
```

The environment drift test keeps literal `process.env.*` reads documented:

Per-tenant runtime settings control payload capture: `telemetryPayloads`
defaults to `metadata` (Proxy→Provider method + allowlisted headers only).
`bounded` opts a tenant into redacted, size-limited body capture; `none` turns
drawer capture off. Both capture modes use a 15-minute TTL. The active
environment template also exposes the local `.jsonb` backing-store directory,
file-size bound, and retention override.

```bash
bun test test/config-env-drift.test.ts
```

## Development commands

```bash
bun run dev
bun run dev:backend
bun run dashboard:dev
bun run setup
bun run doctor
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:build
bun run build:aot
bun run build:binary
bun run build
bun run start
bun run restart
```

`bun run build` produces the standalone binary in three steps: build the
dashboard assets, run the Elysia AOT precompile into `dist/main.js`, then
compile that output into `dist/cartethyia`. The binary step reads the AOT output
rather than `src/main.ts` — the AOT pass rewrites TypeBox into statically wired
imports, and bundling the raw source instead leaves an unresolvable
`require("typebox/type")` in the executable. It also bakes `NODE_ENV=production`
into the artifact, which the binary needs in order to avoid the development-only
pretty-print log transport.

`bun run restart` rebuilds and restarts the running instance gracefully: it stops
the old process through the drain endpoint (below) when `CARTETHYIA_DRAIN_TOKEN`
is set, and only force-kills when no token is configured. A graceful stop lets
in-flight requests finish (a drain window, default 20s) and tells any aborted
stream the process is going away via a terminal frame, instead of truncating the
response mid-flight. On Linux the process also handles `SIGTERM`/`SIGINT`
directly; on Windows a catchable signal cannot be delivered to a console-less
process, which is why the drain endpoint exists (`POST /admin/drain`, loopback +
`x-drain-token`, registered only when the token is set).

## Tests and coverage

Tests live under the root `test/` tree. Backend tests mirror the production
layout; cross-cutting suites are grouped under `test/contracts`,
`test/integration`, `test/architecture`, and `test/frontend`.

```bash
bun run test
bun run test:contracts
bun run test:integration
bun run check:coverage
```

The coverage gate requires at least 85% line coverage for handwritten backend
`src/` code. DB-gated tests may be skipped when
`CARTETHYIA_TEST_DATABASE_URL` is not configured; when it is, the gate repoints
the test process's `DATABASE_URL` at that database before any pool is opened and
applies the baseline migration and bundled provider catalog there, so fixtures
never land in the database your `DATABASE_URL` names.

## Docker

```bash
docker compose up --build -d
docker compose logs -f app
docker compose down
```

The Docker image builds the dashboard and compiled backend, exposes port
`12800`, and runs the application as a dedicated non-root user (uid/gid
`10001`). Compose also manages the PostgreSQL and Redis the app connects to:
the app reaches both by service name on the Compose network, and a fresh
`postgres` volume is migrated at first boot. To use an external database
instead, override the app's `DATABASE_URL` or remove the `postgres` service.

`docker compose up --build -d` recreates the container, which sends `SIGTERM`:
the old process drains and answers callers `503 shutting_down` while the new one
starts. To tell clients the process is coming straight back — an in-place image
swap rather than a stop — send `SIGUSR2` to the old process first
(`docker kill -s SIGUSR2 <container>`); it drains with the `update` reason and
answers `503 restart_for_update: system will be back in a minute` instead.

If you bind-mount or attach a volume at the data directory for telemetry payload
capture, the mount's ownership overrides the image's. The entrypoint starts as
root, takes ownership of that directory for uid/gid `10001`, and only then drops
privileges to run the application, so a root-owned mount works with no host-side
preparation. Ownership is only repaired when the container is allowed to start
as root — an explicit `USER`, `--user`, or a platform that forbids root skips it,
and in that case prepare the host directory with the runtime uid:

```bash
mkdir -p ./data && sudo chown -R 10001:10001 ./data
```

Without either, the directory is not writable by the runtime user, every payload
capture fails while the console still shows the switch as On, and the gateway
logs a single warning naming the directory and this fix.

### Migrating an existing deployment

The application migrates itself at boot: it applies every numbered
`NNNN_*.sql` file under `migrations/` in order and records each in the
`cartethyia_schema_migrations` ledger, so a new database and an existing one
both reach the current schema with no manual step. `0000_baseline.sql` is the
whole schema for a database created today; later numbered files converge
existing databases automatically at startup.

To move a deployment's configuration to another host, use **Settings →
Backup** in the console:

1. On the source, export a backup. It downloads as plain JSON and contains every
   provider credential and API-key hash, so treat the file as secret. Export
   requires the operator's console password.
2. On the destination, start the new instance against an empty database and wait
   for `/health/ready` to return `200`. Boot creates the schema and seeds the
   bundled provider catalog, which the import depends on.
3. Import the file on the destination. It re-authenticates the same way.

A backup carries a tenant's own configuration and its request telemetry, not the
shared built-in catalog (the build re-supplies that) and not captured
prompt/response bodies. Restore replaces the importing tenant's config rows,
merges telemetry without duplicating it, and cannot touch another tenant's rows.

Public share links may include an optional donation or information popup with an image, copy, and HTTPS/mailto action. Visitors open it from the button under Base URL; it never interrupts page load.
It is not a substitute for a database dump.

## Providers and egress

Provider integrations live under `src/providers/integrations/`. Generated
protobuf output consumed by the Devin integration is committed under its
integration directory.

Supported network pool transports are:

- HTTP CONNECT
- HTTPS CONNECT
- SOCKS5

Pool endpoints are SSRF-validated at creation and connection time. Configured
pool failures are surfaced; requests do not silently fall back to direct egress.

## Generated protobuf

The Devin integration consumes committed protobuf output under its own
integration directory (`src/providers/integrations/devin/generated/`). It is
build input: normal typecheck, build, setup, and Docker build read it as-is and
never regenerate it, so none of them need Buf, network access, or external code
generation. Regenerating is a separate, deliberate step.

## Repository map

```text
src/        production backend
 test/      backend and contract tests
 dashboard/ React/Vite dashboard (route and browser-boundary map in `dashboard/README.md`)
 scripts/   flat operational scripts
 migrations/ tracked SQL migrations, applied automatically at boot
```

For repository-local coding conventions, cutover rules, and cleanup rules, see
`AGENTS.md` (§5–§9).
