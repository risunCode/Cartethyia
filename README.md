# Cartethyia

> # WARNING WARNING WARNING
> ## CARTETHYIA IS STILL FRAGILE. GUNAKAN DENGAN RISIKO SENDIRI.
> ## PROJECT INI TIDAK MENERIMA PR.

A self-hosted Bun + Elysia AI proxy with an authenticated web console. Accepts OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages requests, routes them across 30+ provider adapters with OAuth and API-key credentials, translates responses cross-protocol, and manages everything from a real-time dashboard.

**Current release:** `1.0.8-alpha` (2026-08-06)

## Features

### Proxy core

- **OpenAI Chat Completions** (`POST /v1/chat/completions`), **OpenAI Responses** (`POST /v1/responses`), and **Anthropic Messages** (`POST /v1/messages`) — all three client surfaces served from one process.
- **Cross-protocol translation** — a request on any surface can route to any compatible upstream provider through shared codecs. A Chat request can hit an Anthropic upstream, a Messages request can hit an OpenAI Responses upstream, etc.
- **Image generation** at `POST /v1/images/generations` (OpenAI-compatible).
- **Streaming and non-streaming** — SSE/NDJSON framing with canonical `StreamEvent` values, translated back to the requested client surface. Reasoning/thinking content, tool calls, usage, stop reasons, and refusals are preserved end-to-end.
- **Model catalog** at `GET /v1/models` — lists direct models, router aliases, and combos permitted by the authenticated API key. Entries carry real context limits, capability categories, and USD pricing per 1M tokens sourced from models.dev. Unknown values stay `null`; limits and prices are never fabricated.

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
- **Proxy pool** — route provider traffic through HTTP/HTTPS/SOCKS5 proxies with priority, weight, concurrency caps, and per-proxy health. Cloudflare Warp instances are auto-injected as SOCKS5 proxies.

### Providers

30+ built-in adapters across four categories:

| Category | Providers |
| --- | --- |
| **OAuth** | Claude Code (Anthropic OAuth), Codex, Cline, Cline Pass, Antigravity, Grok Build, Kiro (AWS Builder ID) |
| **API-key** | OpenAI, Anthropic, Gemini, Cloudflare Workers AI, Groq, Alibaba Cloud / DashScope, Fireworks AI, DeepSeek, Ollama Cloud, Mistral, SiliconFlow, Cerebras, NVIDIA NIM, Blackbox AI, OpenRouter, OpenCode Free, OpenCode Zen, OpenCode Go, Xiaomi MiMo (PAYG + Token Plan), CodeBuddy, CodeBuddy CN, Exa |
| **Compatible** | AgentRouter, Command Code, Qoder, Kimchi |
| **Custom** | Console-managed OpenAI-compatible and Anthropic-compatible endpoints with custom headers, model metadata, and `<slug>/<model>` routing |

Provider adapters that proxy as a specific upstream client identity (Claude Code, Grok Build, Kiro, Qoder, etc.) emit that client's canonical `User-Agent` fingerprint so the upstream sees a legitimate session. Cartethyia never presents its own identity upstream.

### Dashboard

- **Overview** — live health (JS heap, native, external, ArrayBuffer, CPU), in-flight requests, uptime, server-synced clocks, GitHub release badge.
- **Providers** — account management, OAuth flows, credential import, model testing, per-provider model catalog, batch selection, bulk operations.
- **Model Studio** — built-in chat playground that sends through the exact same dispatch pipeline as real `/v1/*` traffic. Supports reasoning effort, session save/resume, sanitized Markdown rendering with code blocks.
- **API Keys** — full lifecycle (create, edit, enable, disable, revoke, regenerate), token budgets (monthly/one-time), per-key RPM/concurrency limits, provider/model allowlists and denylists, public share pages with connection details and usage.
- **Combos & Aliases** — create, edit, delete; live resolve-preview showing the actual routed target.
- **Proxy Pools** — CRUD, batch URL import, protocol detection, priority/active controls, Warp pool integration.
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
- Credential/secret masking in all console list/detail endpoints (API keys, Warp credentials). Raw secrets available only through explicit credential endpoints.
- Sanitized error messages at public API and console boundaries.
- No request/response bodies persisted in telemetry unless an explicitly documented storage mode requires it.

## Quick start

Requirements: Bun 1.x and a writable data directory.

```bash
bun install
cd dashboard && bun install && cd ..
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
| `GET` | `/v1/models` | Routeable models, router aliases, and combos for the authenticated API key |
| `GET` | `/health` | Liveness check |

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
CONSOLE_PASSWORD             # console login password
CONSOLE_JWT_SECRET           # JWT signing secret (auto-generated if unset)
BOOTSTRAP_PROXY_API_KEY      # initial proxy API key
DB_PATH                      # config SQLite path (default inside DATA_DIR)
RUNTIME_DB_PATH              # runtime telemetry SQLite path (default inside DATA_DIR)
MAX_FLIGHTS_PER_IP           # global concurrent requests per IP
LOG_RETENTION_DAYS           # console log retention
ASSET_RETENTION_DAYS         # asset retention
```

Adaptive scaling is enabled by default — per-IP flight tracking, API-key admission, login rate limiting, and GC interval auto-derive from available process memory. Override via `CARTETHYIA_MAX_TRACKED_IPS`, `CARTETHYIA_MAX_TRACKED_KEYS`, `CARTETHYIA_LOGIN_MAX_TRACKED_IPS`, and `CARTETHYIA_GC_INTERVAL_MS` (all default `0` = adaptive).

For deployment, persist `DATA_DIR` and configure the console password, proxy API key, and JWT secret through the platform's secret manager.

## Docker

```bash
docker build -t cartethyia .
docker run --rm -p 12800:8080 \
  -e PORT=8080 \
  -e DATA_DIR=/app/data \
  -e CONSOLE_PASSWORD=change-me \
  -e CONSOLE_JWT_SECRET=replace-with-a-long-random-secret \
  -e BOOTSTRAP_PROXY_API_KEY=change-me \
  -v cartethyia-data:/app/data \
  cartethyia
```

The container also exposes Warp SOCKS5 proxy ports `40001-40020` (internal `127.0.0.1` only). These are declared via `EXPOSE` and `expose:` so Railway and similar platforms are aware of the port range — the proxy pool connects to them over loopback inside the container. They are not mapped to the host.

## Development

```bash
bunx tsc --noEmit -p .
bun test --timeout 60000 test/
cd dashboard && bun run build && bun run test
```

## Documentation

In-depth guides live in [`docs/`](./docs/):

| Doc | Covers |
| --- | --- |
| [`model-catalog.md`](./docs/model-catalog.md) | Pricing & context sourcing (models.dev), sync, fallback behavior |
| [`protocol-translation.md`](./docs/protocol-translation.md) | Cross-protocol translation, response shaping, streaming |
| [`alias-routing.md`](./docs/alias-routing.md) | Alias & combo resolution, pricing inheritance, live test |
| [`console-api.md`](./docs/console-api.md) | Full `/console/api/*` control-plane endpoint reference |
| [`oauth-drivers.md`](./docs/oauth-drivers.md) | OAuth driver registry, bundled flows, custom drivers |
| [`auth-security.md`](./docs/auth-security.md) | Auth boundaries, ACL, credential lease, SSRF/redirect guards |

## Project boundaries

```text
src/domain/protocols/     Protocol normalization and translation
src/providers/            Provider adapters and model catalogs
src/transport/protocols/  Upstream HTTP and stream execution
src/app/                  Routing, failover, recovery sweep, limits, orchestration
dashboard/src/            React authenticated console
```

Release history and migration notes are in [`CHANGELOG.md`](./CHANGELOG.md).

## Credits

Built with:

- [Bun](https://bun.sh) — JavaScript runtime & bundler
- [Elysia](https://elysiajs.com) — web framework
- [SQLite](https://www.sqlite.org) — config & telemetry storage (via Bun's built-in `bun:sqlite`)
- [wgcf](https://github.com/ViRb3/wgcf) — Cloudflare Warp account registration (vendored, Go)
- [wireproxy](https://github.com/windtf/wireproxy) — WireGuard userspace proxy (vendored, Go)
- [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) — SOCKS5 proxy agent for Node/Bun
- [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es) — Protocol Buffers runtime (Kiro AWS EventStream)

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

Model metadata sourced from [models.dev](https://models.dev).
