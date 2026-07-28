# Cartethyia

OpenAI ⇄ Anthropic compatibility reverse proxy. One server, three client-facing
API shapes — **OpenAI Chat Completions**, **OpenAI Responses**, and
**Anthropic Messages** — each of which can be routed to *either* upstream by
model name, translated on the fly.

```
client (any of the 3 shapes) → Cartethyia → OpenAI or Anthropic upstream
```

## Why

If your client only speaks OpenAI's Chat Completions API, you can still call
Claude models through it — Cartethyia translates the request to Anthropic
Messages, calls Anthropic, and translates the response back. The same holds
in every direction: Anthropic-shape client → OpenAI upstream, OpenAI
Responses-shape client → Anthropic upstream (via Chat as the intermediate),
and so on. Native pairs (OpenAI client → OpenAI upstream, Anthropic client →
Anthropic upstream) pass through untouched — no translation overhead.

## Quickstart

```bash
bun install
cp .env.example .env
bun run dev            # bun --watch src/server.ts, listens on :12800
```

```bash
curl http://localhost:12800/health
# {"status":"ok","service":"cartethyia"}

# The caller supplies its own provider key; Cartethyia never reads it from .env.
curl -X POST http://localhost:12800/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer $ANTHROPIC_API_KEY" \
  -d '{"model":"claude-3-5-sonnet-20241022","messages":[{"role":"user","content":"hi"}]}'
# ^ OpenAI-shape request, model name routes it to Anthropic; the Bearer value
#   is adapted to Anthropic's x-api-key header and the response comes back in
#   OpenAI Chat shape.
```

## Configuration

All config is env vars, loaded once at boot (`src/config.ts`). See
`.env.example` for the full list. This core build is direct **BYOK**:

- Each request supplies its real upstream credential: `Authorization: Bearer …`
  for OpenAI, or `x-api-key` for Anthropic. For Anthropic routing, an
  OpenAI-style Bearer credential is adapted to Anthropic's `x-api-key` header.
- Cartethyia has no provider registry, server-side upstream credentials,
  custom base URLs, or inbound access-key layer yet. Upstream endpoints are
  intentionally fixed to the official OpenAI and Anthropic APIs.
- `/health` remains unauthenticated; any `/v1/*` request missing the needed
  upstream credential returns an upstream-shaped 401 before it reaches the
  network.

### Client traffic controls

Cartethyia resolves a client identity for observability (`ip`, a short hashed
fingerprint, and a coarse client label) and logs **none** of the raw
fingerprint headers or credentials. `/v1/*` requests count as active flights
until their response—including an SSE stream—actually closes.

- `MAX_FLIGHTS_PER_IP=20` is the default ceiling; set `0` to disable it.
  A request beyond the ceiling gets a friendly `429 rate_limit_error` telling
  the caller to wait for an in-flight request or reduce parallel work.
- Direct deployments use Bun's transport IP. `TRUST_PROXY=false` stays the
  safe default: clients cannot spoof `X-Forwarded-For`.
- Set `TRUST_PROXY=true` **only** when Cartethyia is behind a reverse proxy
  you control; then it accepts `CF-Connecting-IP`, `X-Real-IP`, or the first
  `X-Forwarded-For` value as the client IP.

### Outbound transforms

Both transforms run **after** any cross-provider translation and immediately
before the upstream fetch, so native and translated requests behave the same:

- **`CARTETHYIA_SYSTEM_PROMPT`** appends a server-owned instruction to every
  request. It joins the existing OpenAI system/developer message, Responses
  `instructions`, or Anthropic `system`; it is not client-controlled.
- **RTK** (`RTK_ENABLED=true`) is adaptive, not a blanket truncator. It only
  considers successful tool results that unmistakably look like structured
  command output (git diff/status/log, build output, grep, find, tree, ls, or
  search lists). Ordinary prose and error traces always pass untouched. A
  candidate is retained only when it meets `RTK_MIN_CHARS` and removes no more
  than `RTK_MAX_REDUCTION_PERCENT` (defaults: `1500`, `35`), preserving a
  deliberately conservative quality budget. RTK defaults off.

## Routes

| Route | Client shape | Native upstream | Cross-provider upstream |
|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | OpenAI | Anthropic (`claude*` models) |
| `POST /v1/responses` | OpenAI Responses | OpenAI | Anthropic, via Chat as the intermediate |
| `POST /v1/messages` | Anthropic Messages | Anthropic | OpenAI Chat Completions |
| `GET /v1/models` | — | merges both providers' lists | — |
| `GET /health` | — | — | — |

Provider selection is a naming convention (`src/upstream/providers.ts`):
`claude*` model names → Anthropic, everything else → OpenAI.

Streaming (`stream: true`) is supported on every route and every
cross-provider pair — see [`FORMATS.md`](./docs/FORMATS.md).

## Project layout

```
src/
├── server.ts, app.ts, config.ts     entry point, Elysia app assembly, env config
├── http/
│   ├── errors.ts                    friendly OpenAI / Anthropic error envelopes
│   ├── traffic.ts                   privacy-safe client identity + per-IP active-flight tracker
│   └── middleware.ts                request observability + per-IP active-flight gate
├── routes/                          4 route files (chat/messages/responses/status) + TypeBox schemas
├── translate/
│   ├── types.ts                     wire-shape types for all 3 surfaces
│   ├── openai-anthropic.ts          OpenAI Chat ⇄ Anthropic Messages, both route directions
│   ├── openai-responses.ts          OpenAI Chat ⇄ OpenAI Responses, both route directions
│   └── concerns/                    block-level translation building blocks (see below)
└── upstream/
    ├── providers.ts                 provider selection + official API fetch wrappers
    ├── outbound.ts                  configurable system injection + adaptive RTK before fetch
    └── bridge.ts, jsonGuards.ts, sse.ts
```

`translate/concerns/` holds the shared building blocks every translator is
built from, instead of six bespoke pairwise converters:

- `blocks.ts` — the unified content-block model every surface normalizes
  through (`UnifiedTextBlock` / `UnifiedImageBlock` / `UnifiedToolCallBlock` /
  `UnifiedToolResultBlock`), plus the Anthropic role-mapping helper
  (`toAnthropicRole`).
- `normalize.ts` — per-surface normalize (wire shape → unified) and
  denormalize (unified → wire shape) functions.
- `finishReasons.ts` — stop/finish-reason vocabulary mapping tables.
- `toolIntegrity.ts` — pre-upstream Anthropic request repair: filling in
  missing tool results and sanitizing tool-call ids. See
  [`TOOL_CALLING.md`](./docs/TOOL_CALLING.md).
- `tools.ts` — tool schema conversion, `tool_choice` translation, and
  `arguments`(string)⇄`input`(object) correlation. See
  [`TOOL_CALLING.md`](./docs/TOOL_CALLING.md).
- `image.ts` — magic-byte media-type sniffing, base64 decode/validate,
  data-URI helpers.
- `cache.ts` — prompt-cache breakpoint placement and usage normalization.
  See [`CACHING.md`](./docs/CACHING.md).

## Development

```bash
bun run dev             # watch mode
bunx tsc --noEmit       # typecheck (strict mode)
bun test                # 165 tests: concerns/unit transforms, client traffic,
                         # route integration, and streaming bridge tests
```

## Further reading

- [`FORMATS.md`](./docs/FORMATS.md) — request/response and streaming translation details per route.
- [`CACHING.md`](./docs/CACHING.md) — how prompt-cache breakpoints are chosen and usage is normalized.
- [`TOOL_CALLING.md`](./docs/TOOL_CALLING.md) — tool schema and call-id correlation across the three surfaces.
