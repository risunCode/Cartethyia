# Cartethyia
<img width="1760" height="576" alt="image (1)" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

> **2.0.0 Beta is here.**
> Cartethyia is still beta software. Expect provider API changes and validate your credentials, proxy settings, and persistent data before production use.
> This project is maintained as a self-hosted deployment, and pull requests are welcome as of the 2.0 beta.

A self-hosted Go daemon with the existing React/Vite dashboard. Cartethyia
accepts OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages
requests; Go replaces the legacy server core under `daemon/`, while
`dashboard/` remains the only frontend.

> **Migration status:** the Go core and route contracts are in place.
> Provider/storage wiring and production parity are still being migrated; do
> not treat this foundation build as a production-parity release.

**Current release:** `2.0.0-beta` (2026-08-10)

## Features

### Go daemon foundation

- Runtime lifecycle and composition live under `daemon/internal/runtime/`.
- HTTP server, API, admin, and middleware live under `daemon/internal/server/`.
- Hot-path pool, routing, failure classification, stream handling, request
  sanitization, transforms, and normalized contracts live under
  `daemon/internal/proxy/`.
- Provider registry and adapters live under `daemon/internal/providers/`.
- Credential lifecycle and OAuth/device flows live under `daemon/internal/auth/`.
- PostgreSQL models, migrations, repositories, and backup live under
  `daemon/internal/database/`.
- Process configuration and observability live under
  `daemon/internal/config/` and `daemon/internal/observability/`.
- Legacy TypeScript source remains available as read-only reference under
  `src.old/`.

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

30+ built-in adapters across four categories:

| Category | Providers |
| --- | --- |
| **OAuth** | Claude Code (Anthropic OAuth), Codex, Cline, Cline Pass, Antigravity, Grok Build, Kiro (AWS Builder ID), Cursor |
| **API-key** | OpenAI, Anthropic, Gemini, Cloudflare Workers AI, Groq, Alibaba Cloud / DashScope, Fireworks AI, DeepSeek, Ollama Cloud, Mistral, SiliconFlow, Cerebras, NVIDIA NIM, Blackbox AI, OpenRouter, OpenCode Free, OpenCode Zen, OpenCode Go, Xiaomi MiMo (PAYG + Token Plan), CodeBuddy, CodeBuddy CN, Exa, Devin |
| **Compatible** | AgentRouter, Command Code, Qoder, Kimchi |
| **Custom** | Console-managed OpenAI-compatible and Anthropic-compatible endpoints with custom headers, model metadata, and `<slug>/<model>` routing |

Devin uses the native Codeium Cascade protobuf stream with generated bindings vendored under `src/providers/devin/proto-gen`. Add a Devin account from the provider console with its raw JWT/API key, `Bearer <jwt>`, or `devin-session-token$<jwt>` credential. The built-in model is `swe-1-6-slow` (200K context, 64K output).
Cursor uses the native Cursor Agent Connect/HTTP2 protobuf stream with vendored bindings under `src/providers/cursor/proto-gen`. Add a Cursor account from the provider console with its access token. The adapter exposes Cursor's text/reasoning models through OpenAI Chat and Responses surfaces, including `composer-2.5` (standard) and `composer-2.5-fast` (fast/default), routes HTTP proxy connections, and intentionally rejects client tool definitions because Cartethyia does not execute Cursor's native workspace tools.

Provider adapters that proxy as a specific upstream client identity (Claude Code, Grok Build, Kiro, Qoder, etc.) emit that client's canonical `User-Agent` fingerprint so the upstream sees a legitimate session. Cartethyia never presents its own identity upstream.

### Dashboard

- **Overview** — live health (JS heap, native, external, ArrayBuffer, CPU), in-flight requests, uptime, server-synced clocks, GitHub release badge.
- **Providers** — account management, OAuth flows, credential import, model testing, per-provider model catalog, batch selection, bulk operations.
- **Model Studio** — built-in chat playground that sends through the exact same dispatch pipeline as real `/v1/*` traffic. Supports reasoning effort, session save/resume, sanitized Markdown rendering with code blocks.
- **API Keys** — full lifecycle (create, edit, enable, disable, revoke, regenerate), token budgets (monthly/one-time), per-key RPM/concurrency limits, provider/model allowlists and denylists, public share pages with connection details and usage.
- **Combos & Aliases** — create, edit, delete; live resolve-preview showing the actual routed target.
- **Proxy Pools** — CRUD, batch URL import, protocol detection, priority/active controls.
- **Console Log** — live request logs with proxy pool, token counts, tool names, and message preview.
- **Database Map** — browse schema, run SELECT queries, export/import databases. Table and query views mask sensitive columns; raw SQLite exports contain the underlying secrets and must be handled as sensitive files.
- **Terminal** — in-browser shell with btop, htop, speedtest, fastfetch, curl, sqlite.
- **Settings** — system prompt, filter rules, JWT/session config, adaptive scaling controls.
- Responsive desktop and mobile layouts, reduced-motion support, custom backgrounds, seasonal effects.

### Security

- API-key ACL with provider/model allowlists and denylists.
- Per-IP admission, in-flight tracking, and login rate limiting — all adaptive to available process memory.
- SSRF and redirect guards on all upstream and proxy URLs (private IPv4/IPv6, DNS rebinding, redirect chains).
- Bounded body, stream, timeout, and concurrency protections.
- Credential/secret masking in all console list/detail endpoints (API keys). Raw secrets available only through explicit credential endpoints.
- Sanitized error messages at public API and console boundaries.
- No request/response bodies persisted in telemetry unless an explicitly documented storage mode requires it.

## Quick start

Requirements: Go 1.26.5, Bun 1.4, PostgreSQL, and a writable data directory.

Start the Go API:

```bash
bun run dev
```

In a second terminal, run the dashboard:

```bash
cd dashboard
bun install
bun run dev
```

The dashboard dev server proxies `/console/api` and `/v1` to the Go daemon on
port `12800`. Open <http://localhost:5173/> for the landing page; the
landing-page Console links continue to <http://localhost:5173/console/>.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/images/generations` | OpenAI-compatible image generation |
| `POST` | `/v1/images/edits` | OpenAI-compatible image editing (multipart or JSON) |
| `GET` | `/v1/models` | Routeable models for the authenticated API key |
| `GET` | `/health` | Public process liveness |
| `GET` | `/share/<token>` | Credential-free API-key usage monitor |
| `GET` | `/share/setup/<token>` | One-time setup page; expires after 15 minutes |

Dashboard browser APIs use `/v2/*` routes under `/console/api`; `/v1/*` is
reserved for external client protocol ingress. Dashboard reads and actions use
standard `GET`, `POST`, `PATCH`, and `DELETE` methods.

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
CARTETHYIA_ACCOUNT_ENCRYPTION_KEY # account secret encryption key; required with PostgreSQL
CARTETHYIA_ALLOW_INMEMORY  # explicit development-only escape hatch
PUBLIC_ORIGIN              # dashboard/API origin used for browser checks
TRUST_PROXY                # enable only behind a trusted reverse proxy
```

The Go daemon owns API, proxy, provider, storage, and authentication
execution. The dashboard is a separate React/Vite client and is not embedded
in the Go binary or served by it.
The Go daemon owns the hot-path request lifecycle and runs as one process.
Scale-out belongs to the deployment platform. Build the existing dashboard
separately with `bun run build:dashboard`; it is never copied into or served
by the Go binary.

## Docker

The root Dockerfile is the only deployment definition. Its default `runtime`
target contains the Go API only; the `dashboard` target builds the existing
React/Vite frontend as a separate image when needed.

```bash
docker build --target runtime -t cartethyia .
docker build --target dashboard -t cartethyia-dashboard .
docker run --rm -p 12800:12800 \
  -e CARTETHYIA_LISTEN_ADDRESS=:12800 \
  -e CARTETHYIA_ENV=production \
  -e CARTETHYIA_DATABASE_URL="$CARTETHYIA_DATABASE_URL" \
  -e CARTETHYIA_REDIS_URL="$CARTETHYIA_REDIS_URL" \
  -e CARTETHYIA_ACCOUNT_ENCRYPTION_KEY="$CARTETHYIA_ACCOUNT_ENCRYPTION_KEY" \
  cartethyia
```

For the complete local stack, use `docker compose up -d`. Compose starts
PostgreSQL and Redis first, waits for both healthchecks, and then starts the
daemon. It reads the runtime secret from `.env`; copy `.env.example` and set
`CARTETHYIA_ACCOUNT_ENCRYPTION_KEY` when that file is absent. The compose
defaults use the service DNS names; override them with
`CARTETHYIA_COMPOSE_DATABASE_URL` or `CARTETHYIA_COMPOSE_REDIS_URL` only when
the dependencies run outside the Compose network. Set `CARTETHYIA_ENV_FILE`
to use a different runtime env file.

## Development

Go hot reload uses Air from the repository root:

```bash
go install github.com/air-verse/air@latest
bun run dev
```

The Air config is `daemon/.air.toml`; it rebuilds the single Go binary into
`daemon/tmp/` and restarts it on Go source changes. The API remains on port
`12800`.

Run verification:

```bash
bun run test
bunx tsc --noEmit -p .
bun test --timeout 60000 test/
cd dashboard && bun run build && bun run test
```

## Documentation and source map

The [active documentation index](./docs/README.md) links to the consolidated
architecture, routing, protocol, operations, and engineering documents.
Release history remains in [`CHANGELOG.md`](./CHANGELOG.md). The main source
areas are:

| Area | Location | Purpose |
| --- | --- | --- |
| Go daemon | [`daemon/`](./daemon/) | API server, proxy, providers, database, and runtime |
| Legacy TypeScript | [`src.old/`](./src.old/) | Read-only migration reference |
| Dashboard | [`dashboard/src/`](./dashboard/src/) | The single React/Vite frontend |

See [Engineering](./docs/engineering.md) for the current verification commands and behavior-focused test scope.

## Credits

Daemon:

- [Go](https://go.dev) — Cartethyia runtime and API

Dashboard:

- [Bun](https://bun.sh) — dashboard runtime and bundler
- [React](https://react.dev) 19 + [Vite](https://vitejs.dev) 6

- [TanStack Query](https://tanstack.com/query) — server state & cache
- [Tailwind CSS](https://tailwindcss.com) 4 — styling
- [Framer Motion](https://www.framer.com/motion) — animations
- [Recharts](https://recharts.org) — usage charts
- [React Router](https://reactrouter.com) 7 — routing
- [Lucide](https://lucide.dev) — icons
- [Sonner](https://sonner.emilkowal.ski) — toast notifications
- [React Markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm) — Model Studio rendering
