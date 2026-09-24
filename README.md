# Cartethyia

<img width="1760" height="576" alt="Cartethyia banner" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

**A self-hosted AI gateway that speaks every client protocol and every provider
dialect — so you configure a route once, and any client can reach any model.**

Cartethyia sits between your AI clients and your provider accounts. It accepts
the wire formats real tools already speak, normalizes every one of them into a
single canonical request, then routes that request across provider accounts and
models under admission control, capability checks, health tracking, and
validated egress.

The result is one endpoint, one key, one dashboard. Point Claude Code, Codex,
Cursor, or any OpenAI-compatible client at it, and let the gateway work out which
account serves the request, whether the provider can express what the client
asked for, and what to do when it cannot.

Built with Bun, TypeScript, Elysia, PostgreSQL, and optional Redis coordination.

## Highlights

- **40 bundled provider integrations** — OpenAI, Anthropic, Codex, Gemini, Grok,
  Cursor, Devin, Mistral, Groq, OpenRouter, Cerebras, NVIDIA, Cloudflare,
  DeepSeek-family gateways, and more, each with its own authentication, wire
  quirks, and identity headers.
- **Four client protocols, one canonical model** — Chat Completions, Responses,
  Messages, and legacy Completions all normalize into the same request shape.
  A client's protocol is a property of the connection, not of the route.
- **Capability-aware routing that translates instead of rejecting** — when a
  chosen model cannot express something the client asked for, the request is
  degraded in place (generation controls dropped, media replaced by placeholders)
  rather than silently rerouted to a model you never asked for.
- **Account health as a state machine** — every failure is classified into
  `active` / `degraded` / `cooldown` / `disabled`, with per-account and per-model
  backoffs, automatic recovery, and a full transition log you can read.
- **Validated egress pools** — HTTP CONNECT, HTTPS CONNECT, and SOCKS5, with
  SSRF validation at both creation and connection time. Configured pool failures
  surface as failures; a request never silently falls back to direct egress.
- **Multi-tenant by construction** — tenants, scoped API keys, model
  allow/deny lists, per-key rate and token budgets, and a public usage share
  page.
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

Anything else under `/v1/` is not routed. A path the gateway does not serve
returns `404` with `{"error":{"code":"not_found"}}` rather than being forwarded
upstream, so a typo surfaces immediately instead of reaching a provider.

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

PostgreSQL is external in native and Docker setups. Redis is optional when using
`REDIS_MODE=single_instance_local`.

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

`bun run dev` runs the stack behind a supervisor proxy on that same port:
press **CTRL+R** in its terminal to restart backend + dashboard in place —
client requests arriving during the restart gap are held (added latency, no
`connection refused`) until the backend is listening again. **CTRL+C** stops
everything. `bun run dev:stack` runs the raw stack without the supervisor.

Useful endpoints:

```text
/health       liveness
/health/ready readiness
/metrics      Prometheus metrics
/v1/*         gateway APIs
/console      dashboard
```

## Dashboard

The console is served from the same application and covers the whole operational
surface:

- **Overview** — traffic, success rate, latency, and provider health at a glance
- **Usage** — per-request telemetry with request detail and payload inspection
- **Providers** — accounts, credentials, health, and per-model probing
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

Per-tenant runtime settings control request-body capture: `telemetryPayloads`
defaults to `bounded` (redacted, size-limited, 15-minute TTL) and `none` is the
kill-switch for new payload rows. The active environment template also exposes
the local `.jsonb` backing-store directory, file-size bound, and retention
override.

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
bun run build
```

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

The offline coverage gate requires at least 75% line coverage for handwritten
backend `src/` code. DB-gated tests may be skipped when
`CARTETHYIA_TEST_DATABASE_URL` is not configured; when it is, the suite runs
against that database and leaves `DATABASE_URL` alone.

## Docker

```bash
docker compose up --build -d
docker compose logs -f app
docker compose down
```

The Docker image builds the dashboard and compiled backend, runs as a dedicated
non-root user, and exposes port `12800`. PostgreSQL must be reachable through
`DATABASE_URL`; Compose manages Redis only.

## Providers and egress

Provider integrations live under `src/providers/integrations/`. Generated
protobuf output consumed by Cursor and Devin integrations is committed under
their integration directories.

Supported network pool transports are:

- HTTP CONNECT
- HTTPS CONNECT
- SOCKS5

Pool endpoints are SSRF-validated at creation and connection time. Configured
pool failures are surfaced; requests do not silently fall back to direct egress.

## Generated protobuf

Cursor and Devin integrations consume committed protobuf output under their own
integration directories (`src/providers/integrations/*/generated/`). It is
build input: normal typecheck, build, setup, and Docker build read it as-is and
never regenerate it, so none of them need Buf, network access, or external code
generation. Regenerating is a separate, deliberate step.

## Repository map

```text
src/        production backend
 test/      backend and contract tests
 dashboard/ React/Vite dashboard (route and browser-boundary map in `dashboard/README.md`)
 scripts/   flat operational scripts
 drizzle/   database migrations
```

For repository-local coding conventions and cleanup rules, see `AGENTS.md`.
