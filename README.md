# Cartethyia
<img width="1760" height="576" alt="image (1)" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

> **Warning: Go rewrite discontinued.**
> Go rewrite discontinue due to long time development and kekurangan resource yang dibutuhkan.
> Repository is kept for reference only; no further rewrite work is planned.

A self-hosted Go daemon with a SolidJS + Vite dashboard. Cartethyia
accepts OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and
native Gemini generateContent requests; Go replaces the legacy server core
under `router/`, while `dashboard/` remains the only frontend.

> **Migration status:** discontinued; do not plan new rewrite work here.

**Current release:** `2.1.0-beta` (2026-08-16)

## Features

### Go daemon foundation

- Runtime lifecycle and composition live under `router/internal/runtime/`.
- HTTP server, API, admin, and middleware live under `router/internal/server/`.
- Hot-path pool, routing, failure classification, stream handling, request
  sanitization, transforms, and normalized contracts live under
  `router/internal/proxy/`.
- Provider registry and adapters live under `router/internal/providers/`.
- Credential lifecycle and OAuth/device flows live under `router/internal/auth/`.
- PostgreSQL models, migrations, and repositories live under
  `router/internal/storage/`.
- Process configuration and observability live under
  `router/internal/config/` and `router/internal/observability/`.
- Legacy TypeScript source remains available as read-only reference under
  `alegacy/`.

The daemon is currently a foundation build: storage connections, concrete
runtime dependency wiring, and full production parity are not complete.


### Routing and failover

- **Aliases** — map a short name (e.g. `fast`) to any provider/model target. Aliases keep their client-facing ID and inherit metadata from their resolved target.
- **Combos** — group multiple models into a named target with `round-robin` or `fallback` strategy and sticky-session limits.
- **Per-model account locking** — an error on `claude/sonnet-4` does not block `claude/haiku-4` on the same account.
- **3-tier error classification**:
  - **T1 known** (rate-limit, quota, capacity) → cooldown with fine-grained per-reason backoff.
  - **T2 transient** (5xx, network, stream, protocol) → no cooldown; account stays eligible.
  - **T3 permanent** (invalid request, client abort) → no cooldown, skipped entirely.
### Providers

Built-in adapters are registered in `router/internal/providers/` (api-key,
OAuth, and special definitions). The handwritten catalog is the source of
truth; among others:

| Category | Providers |
| --- | --- |
| **OAuth** | Claude Code (Anthropic OAuth), Codex, Cline, Cline Pass, Antigravity, Grok Build, Kiro (AWS Builder ID), Kimchi |
| **API-key** | OpenAI, Anthropic, Groq, xAI, Alibaba Cloud / DashScope (PAYG, coding plan, token plan), Fireworks AI, DeepSeek, Mistral, Moonshot/Kimi, MiniMax, SiliconFlow, Cerebras, NVIDIA, Blackbox AI, OpenRouter, Z.ai / Zhipu, OpenCode Zen, OpenCode Go, Xiaomi MiMo (PAYG + Token Plan), CodeBuddy (+ CN), GitHub Copilot, Ollama (+ Cloud), Together, Novita, HuggingFace, vLLM, LM Studio, LiteLLM, Baseten, CoreWeave, Venice, and more |
| **Compatible** | AgentRouter |
| **Custom** | Database-managed OpenAI-compatible and Anthropic-compatible endpoints with custom headers, model metadata, and `<slug>/<model>` routing |

Provider adapters that proxy as a specific upstream client identity (Claude Code, Grok Build, Kiro, Kimchi, etc.) emit that client's canonical `User-Agent` fingerprint so the upstream sees a legitimate session. Cartethyia never presents its own identity upstream.

### Dashboard

A SolidJS + Vite single-page app under `dashboard/` (Bun is the runtime and
package manager). It talks to the daemon's `/console/*` API with cookie
sessions and ships these pages:

- **Landing / Login** — public marketing home and the console sign-in.
- **Overview** — live request/error totals, error rate, memory, uptime, and
  recent error buckets, refreshed every 5 seconds.
- **Usage** — period-scoped request/token/error telemetry with a request
  volume chart and a live in-flight request stream (SSE).
- **Providers** — provider catalog with account listings, quota aggregates,
  and per-provider success-rate/latency telemetry.
- **Quota** — per-account quota snapshots, refresh, and health state.
- **Console Log** — live tailed operator log stream (SSE), browser client
  error ingest, level/scope filters, and bounded history.
- **Share** — credential-free API-key usage monitor at `/share/:shareId`
  backed by the daemon's public `/share/*` endpoints.
- **Settings** — runtime console settings.
- Responsive desktop and mobile layouts, dark/light theme, reduced-motion
  support.

### Security

- API-key ACL with provider/model allowlists and denylists.
- Per-IP admission, in-flight tracking, and login rate limiting — all adaptive to available process memory.
- SSRF and redirect guards on all upstream and proxy URLs (private IPv4/IPv6, DNS rebinding, redirect chains).
- Bounded body, stream, timeout, and concurrency protections.
- Credential/secret masking in console account list/detail endpoints. Raw secrets never leave the daemon unencrypted.
- Sanitized error messages at public API and console boundaries.
- No request/response bodies persisted in telemetry unless an explicitly documented storage mode requires it.

## Quick start

Requirements: Go 1.26.5, Bun 1.4, PostgreSQL, Redis, and a writable data
directory.

First-time setup:

```bash
bun run setup
```

If you just installed Bun or Go, or changed PATH, restart the terminal before
running the scripts.

Start the cross-platform local dev launcher from the repository root:

```bash
bun run dev
```

For a one-shot setup + dev launch:

```bash
bun run setup:dev
```

Windows direct run:

```bash
bun run windows
```

That path builds the dashboard and router binary directly on Windows, then
starts the router with the built dashboard assets. It expects PostgreSQL and
Redis on `127.0.0.1:5432` and `127.0.0.1:6379`; if Laragon or your local
services live elsewhere, pass `-DatabaseUrl` / `-RedisUrl` to
`tools/run-windows.ps1`.

The cross-platform dev launcher opens the dashboard and router together. The
dashboard dev server on `:12800` proxies `/console` and `/v1` to the Go
daemon, and the daemon's public `/share/*/data|stream` subpaths through to
`:12800`.
Open <http://localhost:5173/> for the landing page; the landing-page Console
links continue to <http://localhost:5173/console/>.

## API

Client ingress and public surfaces served by the daemon on `:12800`:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1beta/models/<model>:generateContent` | Native Gemini generateContent |
| `POST` | `/v1beta/models/<model>:streamGenerateContent` | Native Gemini streaming |
| `POST` | `/v1/images/generations` | OpenAI-compatible image generation |
| `POST` | `/v1/images/edits` | OpenAI-compatible image editing (multipart or JSON) |
| `GET` | `/v1/models` | Routeable models for the authenticated API key |
| `GET` | `/health` | Public process liveness |
| `GET` | `/metrics` | Bounded observability counters |
| `GET` | `/share/<token>` | Credential-free API-key usage monitor |
| `GET` | `/share/setup/<token>` | One-time setup page; expires after 15 minutes |

The console API lives under `/console/*` on the same daemon (cookie
authenticated via the `cartethyia_session` cookie): `auth/*` (login, logout,
session, refresh, OAuth flows), `dashboard`, `telemetry/*` (overview,
requests, errors, upstream, usage, clients, and the two SSE streams
`console/logs/stream` and `telemetry/in-flight/stream`), `console/logs`
and `console/client-errors`, `settings`, `accounts` + provider-scoped account routes, and
`catalog/providers`. Idle SSE streams emit `: ping` comment heartbeats so
proxies keep them alive. `/v1/*` and `/v1beta/*` are reserved for external
client protocol ingress.

Authenticate proxy requests with either header:

```bash
Authorization: Bearer <CARTETHYIA_API_KEY>
x-api-key: <CARTETHYIA_API_KEY>
```

Example:

```bash
curl http://localhost:12800/v1/chat/completions \
  -H "Authorization: Bearer $CARTETHYIA_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

## Configuration
```text
CARTETHYIA_LISTEN_ADDRESS  # Go API listen address (default :12800)
CARTETHYIA_ENV             # development or production
CARTETHYIA_DATABASE_URL    # PostgreSQL DSN; required in production
CARTETHYIA_REDIS_URL       # Redis DSN; optional for development, used by production runtime
CARTETHYIA_ENCRYPTION_KEY  # account secret encryption key; required with PostgreSQL
CARTETHYIA_ALLOW_INMEMORY  # explicit development-only escape hatch
PUBLIC_ORIGIN              # dashboard/API origin used for browser checks
TRUST_PROXY                # enable only behind a trusted reverse proxy
```

The Go daemon owns API, proxy, provider, storage, and authentication
execution. The dashboard is a separate SolidJS/Vite client and is not
embedded in the Go binary or served by it.
The Go daemon owns the hot-path request lifecycle and runs as one process.
Scale-out belongs to the deployment platform. Build the dashboard separately
with `cd dashboard && bun run build`; it is never copied into or served
by the Go binary.

## Docker

The root Dockerfile is the only deployment definition. Targets: `runtime`
(Go daemon, the default) and `dashboard` (nginx + built SPA).

```bash
docker build --target runtime -t cartethyia .
docker build --target dashboard -t cartethyia-dashboard .
docker run --rm -p 12800:12800 \
  -e CARTETHYIA_LISTEN_ADDRESS=:12800 \
  -e CARTETHYIA_ENV=production \
  -e CARTETHYIA_DATABASE_URL="$CARTETHYIA_DATABASE_URL" \
  -e CARTETHYIA_REDIS_URL="$CARTETHYIA_REDIS_URL" \
  -e CARTETHYIA_ENCRYPTION_KEY="$CARTETHYIA_ENCRYPTION_KEY" \
  cartethyia
```

For the complete local stack, use `docker compose up -d`. Compose topology:

- **postgres** / **redis** — start first with healthchecks.
- **cartethyia** — the Go daemon, internal to the compose network only
  (`:12800`, not published).
- **dashboard** — the single public edge: nginx serves the SPA and publishes
  `12800:80`. It proxies `/console/`, `/v1/`, `/v1beta/`, and the public
  `/share/*/data|stream` subpaths to the daemon (SSE locations keep
  buffering off). Browser client-error reports go straight to the daemon's
  `/console/client-errors` route through the `/console/` proxy.

Compose reads the runtime secret from `.env`; copy `.env.example` and set
`CARTETHYIA_ENCRYPTION_KEY` when that file is absent. The compose
defaults use the service DNS names; override them with
`CARTETHYIA_COMPOSE_DATABASE_URL` or `CARTETHYIA_COMPOSE_REDIS_URL` only when
the dependencies run outside the Compose network. Set `CARTETHYIA_ENV_FILE`
to use a different runtime env file.

## Development

`bun run dev` starts the Go router and dashboard dev server together from the
repository root. The Go side runs from source (`go run ./cmd/cartethyia`) and
restarts when Go files change.

```bash
bun run dev
```

For the first launch after a dependency install:

```bash
bun run setup:dev
```

If you prefer the Windows direct build/run path instead of the dev launcher:

```bash
bun run windows
```

Run verification:

```bash
cd router && go build ./... && go test ./...
cd dashboard && bun run test:ci
```

## Visualization

The workspace map lives in [`docs/visualize/`](./docs/visualize/). It is the
only active documentation while the repo is still changing shape.
Release history remains in [`CHANGELOG.md`](./CHANGELOG.md). The main source
areas are:

| Area | Location | Purpose |
| --- | --- | --- |
| Go router | [`router/`](./router/) | API server, proxy, providers, database, and runtime |
| Dashboard | [`dashboard/src/`](./dashboard/src/) | The single SolidJS/Vite frontend |
| Legacy TypeScript | [`alegacy/`](./alegacy/) | Read-only migration reference (`src.old`, `dashboard.old`) |

See [`docs/visualize/`](./docs/visualize/) for the current workspace orientation.

## Credits

Daemon:

- [Go](https://go.dev) — Cartethyia runtime and API

Dashboard:

- [Bun](https://bun.sh) — dashboard runtime and package manager
- [SolidJS](https://solidjs.com) 1.9 + [Vite](https://vitejs.dev) 6
- [TanStack Query](https://tanstack.com/query) (solid bindings) — server state & cache
- [TanStack Virtual](https://tanstack.com/virtual) (solid bindings) — virtualized tables
- [Tailwind CSS](https://tailwindcss.com) 4 — styling
- [@solidjs/router](https://docs.solidjs.com/solid-router) — routing
- [Lucide](https://lucide.dev) — icons
- [Vitest](https://vitest.dev) + [@solidjs/testing-library](https://github.com/solidjs/solid-testing-library) — tests
