# Cartethyia
<img width="1760" height="576" alt="image (1)" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

> **2.0.0 Beta is here.**
> Cartethyia is still beta software. Expect provider API changes and validate your credentials, proxy settings, and persistent data before production use.
> This project is maintained as a self-hosted deployment, and pull requests are welcome as of the 2.0 beta.

A self-hosted Bun + Elysia AI proxy with an authenticated web console. Cartethyia accepts OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages requests; routes them across 30+ provider adapters; translates protocols; manages OAuth/API-key accounts; and exposes routing, quota, usage, and health controls from one dashboard.

**Current release:** `2.0.0-beta` (2026-08-10)

## Features

### Proxy core

- **OpenAI Chat Completions** (`POST /v1/chat/completions`), **OpenAI Responses** (`POST /v1/responses`), and **Anthropic Messages** (`POST /v1/messages`) — all three client surfaces served from one process.
- **Cross-protocol translation** — a request on any surface can route to any compatible upstream provider through shared codecs. A Chat request can hit an Anthropic upstream, a Messages request can hit an OpenAI Responses upstream, etc.
- **Image generation** at `POST /v1/images/generations` (OpenAI-compatible).
- **Streaming and non-streaming** — SSE/NDJSON framing with canonical `StreamEvent` values, translated back to the requested client surface. Reasoning/thinking content, tool calls, usage, stop reasons, and refusals are preserved end-to-end.
- **Model catalog** at `QUERY /v1/models` — lists direct models, router aliases, and combos permitted by the authenticated API key. `GET /v1/models` remains an external compatibility alias and is translated at the unified HTTP boundary.

### Routing and failover

- **Aliases** — map a short name (e.g. `fast`) to any provider/model target. Aliases keep their client-facing ID and inherit metadata from their resolved target.
- **Combos** — group multiple models into a named target with `round-robin` or `fallback` strategy and sticky-session limits.
- **Per-model account locking** — an error on `claude/sonnet-4` does not block `claude/haiku-4` on the same account.
- **3-tier error classification**:
  - **T1 known** (rate-limit, quota, capacity) → cooldown with fine-grained per-reason backoff.
  - **T2 transient** (5xx, network, stream, protocol) → no cooldown; account stays eligible.
  - **T3 permanent** (invalid request, client abort) → no cooldown, skipped entirely.
- **Graduated backoff** — opaque/unknown 429s start at a 30s base that grows exponentially with failure count, escalating to the full 5-minute default only after repeated failures. A single transient blip no longer takes an account offline.
- **Scheduled recovery sweep** — an unref'd 1-minute interval transitions expired cooldowns to healthy and clears expired per-model locks, so accounts recover proactively without waiting for a request to happen to select them.
- **Sticky round-robin** with in-flight awareness — idle accounts are preferred over busy ones within the sticky pool.
- **Proxy pool** — route provider traffic through HTTP/HTTPS/SOCKS5 proxies with priority, weight, concurrency caps, and per-proxy health.

### OAuth and quota lifecycle

- **Central OAuth refresh pool** — request-time refresh, manual refresh, quota refresh, and scheduled refresh share one account-level single-flight lock, preventing refresh-token rotation races.
- **Proactive token refresh coordinator** — provider-specific refresh lead times and stale-token windows run in a bounded, unref'd coordinator.
- **Revocation-aware state** — permanent `invalid_grant`, revoked, expired, and HTTP 400 token responses persist as `reauth_required` instead of causing blind retry loops.
- **General quota transport** — provider quota fetchers live under `src/providers/quota/` and are shared by account/API workers.
- **Quota refresh worker** — bounded polling, per-account coalescing, failure cooldowns, and persisted success/error state.
- **Provider quota coverage** — Codex, Claude, Antigravity, Kiro, Cline, Qoder, and Grok Build quota paths with provider-specific headers and endpoint contracts.

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
- **Usage** — token/cost charts, per-key/per-provider/per-model breakdowns, request history with IP monitoring.
- **Console Log** — live request logs with proxy pool, token counts, tool names, and message preview.
- **Database Map** — browse schema, run SELECT queries, export/import databases. Sensitive columns are masked.
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

Requirements: Bun 1.4 canary and a writable data directory.

```bash
bun install
cd dashboard && bun install && bun run build && cd ..
cp .env.example .env
bun run dev
```

Open:

- Console: <http://localhost:12800/console/login>
- Health: <http://localhost:12800/health>

Set `CONSOLE_PASSWORD` and `BOOTSTRAP_PROXY_API_KEY` in `.env` for local use.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/images/generations` | OpenAI-compatible image generation |
| `POST` | `/v1/images/edits` | OpenAI-compatible image editing (multipart or JSON) |
| `QUERY` | `/v1/models` | Routeable models, router aliases, and combos for the authenticated API key; legacy `GET` is translated |
| `GET` | `/health` | Public process liveness |
| `GET` | `/share/<token>` | Credential-free API-key usage monitor |
| `GET` | `/share/setup/<token>` | One-time setup page; expires after 15 minutes |

The console API creates these links with `POST /console/api/keys/:id/share` and `POST /console/api/keys/:id/setup-link`. Monitor links never return the API key. Setup links return the key once over the setup data request, then atomically become unusable; use HTTPS when sharing either URL.
Read-only console API calls use `QUERY` with `Content-Type: application/json`; legacy `GET /console/api/*` callers are translated to the same internal route. SSE streams, health probes, static pages, and share links remain `GET`.

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

Use [`.env.example`](./.env.example) as the configuration reference. Common settings:

```text
PORT                         # server port (default 12800)
DATA_DIR                     # persistent data directory (default ./data)
PUBLIC_ORIGIN                # exact public console origin used for same-origin checks
TRUST_PROXY                  # set true only when requests come through a trusted reverse proxy (default false)
CONSOLE_PASSWORD             # console login password (required on first production startup)
CONSOLE_JWT_SECRET           # JWT signing secret (generated only when no persisted secret exists)
RUNTIME_DB_PATH              # runtime telemetry SQLite path (default inside DATA_DIR)
MAX_FLIGHTS_PER_IP           # global concurrent requests per IP
CARTETHYIA_PROXY_SCRAPE_CONCURRENCY # bounded scraper health checks (default 20, cap 64)
LOG_RETENTION_DAYS           # console log retention
ASSET_RETENTION_DAYS         # asset retention
CARTETHYIA_HEADROOM_ENABLED       # enable optional fail-open Headroom /v1/compress
CARTETHYIA_HEADROOM_URL           # Headroom base URL (for example http://127.0.0.1:8787)
CARTETHYIA_HEADROOM_TIMEOUT_MS    # Headroom request timeout (default 3000)
CARTETHYIA_HEADROOM_COMPRESS_USER_MESSAGES # opt in to Headroom user-message compression
```
Bun.serve() handles asynchronous HTTP and provider I/O concurrency natively. The server runs as one process; scale-out belongs to the deployment platform rather than the application runtime.
Requests accept up to 2048 history items. Histories above 512 trigger an emergency RTK pass over older tool results; user and assistant turns are not silently removed. When Headroom is enabled, it runs as an additional fail-open tool-result compaction step.

Adaptive scaling is enabled by default — per-IP flight tracking, API-key admission, login rate limiting, and GC interval auto-derive from available process memory. Override via `CARTETHYIA_MAX_TRACKED_IPS`, `CARTETHYIA_MAX_TRACKED_KEYS`, `CARTETHYIA_LOGIN_MAX_TRACKED_IPS`, and `CARTETHYIA_GC_INTERVAL_MS` (all default `0` = adaptive).

For deployment, persist `DATA_DIR` and configure the console password, proxy API key, and JWT secret through the platform's secret manager.

Warp instances are manual-only. A server restart clears stale `running`/PID state but never starts an account automatically; start instances explicitly from the MultiWarp console or API.

`bun run build` produces the compiled server at `bin/cartethyia` (`bin/cartethyia.exe` on Windows). Use `bun run build:dashboard` to generate `dashboard/dist`, or `bun run build:all` to build the dashboard first and then the server. The dashboard must be built before serving a production-like backend because the server serves those browser assets at runtime.

## Docker

```bash
docker build -t cartethyia .
: "${CONSOLE_PASSWORD:?Set a non-empty CONSOLE_PASSWORD first}"
: "${CONSOLE_JWT_SECRET:?Set a random CONSOLE_JWT_SECRET first}"
: "${PUBLIC_ORIGIN:?Set PUBLIC_ORIGIN to the exact public console origin first}"
docker run --rm -p 12800:8080 \
  -e PORT=8080 \
  -e DATA_DIR=/app/data \
  -e PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
  -e TRUST_PROXY="${TRUST_PROXY:-false}" \
  -e CONSOLE_PASSWORD="$CONSOLE_PASSWORD" \
  -e CONSOLE_JWT_SECRET="$CONSOLE_JWT_SECRET" \
  -e BOOTSTRAP_PROXY_API_KEY="${BOOTSTRAP_PROXY_API_KEY:-}" \
  -v cartethyia-data:/app/data \
  cartethyia
```

## Development

```bash
bunx tsc --noEmit -p .
bun test --timeout 60000 test/
cd dashboard && bun run build && bun run test
```

## Documentation and source map

The [documentation index](./docs/README.md) covers installation, API contracts, translation, provider behavior, operations, and development. The repository keeps release history in [`CHANGELOG.md`](./CHANGELOG.md). The main source areas are:

| Area | Location | Purpose |
| --- | --- | --- |
| Application contracts | [`src/application/`](./src/application/) | Validation, routing, orchestration, and shared contracts |
| Authentication and accounts | [`src/auth/`](./src/auth/) | Credentials, OAuth, token refresh, account health, and quota lifecycle |
| OpenSSE core | [`src/open-sse/`](./src/open-sse/) | Translation, transport, canonical stream events, and codecs |
| Provider adapters | [`src/providers/`](./src/providers/) | Provider identities, models, upstream request handling, and quota transport |
| Console/API | [`src/console/`](./src/console/) | Authenticated control-plane services and API routes |
| Dashboard | [`dashboard/src/`](./dashboard/src/) | React authenticated web console |

Read [`.tester/TEST-PLAN.md`](./.tester/TEST-PLAN.md) for the repository's verification scope.

## Credits

Built with:

- [Bun](https://bun.sh) — JavaScript runtime & bundler
- [Elysia](https://elysiajs.com) — web framework
- [SQLite](https://www.sqlite.org) — config & telemetry storage (via Bun's built-in `bun:sqlite`)
- [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) — SOCKS5 proxy agent for Node/Bun

Dashboard built with:

- [React](https://react.dev) 19 + [Vite](https://vitejs.dev) 6
- [TanStack Query](https://tanstack.com/query) — server state & cache
- [Tailwind CSS](https://tailwindcss.com) 4 — styling
- [Framer Motion](https://www.framer.com/motion) — animations
- [Recharts](https://recharts.org) — usage charts
- [React Router](https://reactrouter.com) 7 — routing
- [Lucide](https://lucide.dev) — icons
- [Sonner](https://sonner.emilkowal.ski) — toast notifications
- [React Markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm) — Model Studio rendering
