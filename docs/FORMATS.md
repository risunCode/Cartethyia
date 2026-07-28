# Formats

How each route translates its client-facing shape to whichever upstream the
requested model routes to. See the README's routing table for which
`(route, model)` pairs are native passthrough vs. cross-provider translation.

## The unified content-block model

Cross-provider translation never goes directly wire-shape ⇄ wire-shape.
Every translator goes through `translate/concerns/blocks.ts`'s
`UnifiedBlock` model as the intermediate:

```
OpenAI Chat message[]  ─┐                    ┌─ OpenAI Chat message[]
Anthropic message[]    ─┼─ normalize ──► UnifiedMessage[] ──► denormalize ─┼─ Anthropic message[]
OpenAI Responses item[]─┘                    └─ OpenAI Responses item[]
```

`UnifiedBlock` is one of `UnifiedTextBlock`, `UnifiedImageBlock`,
`UnifiedToolCallBlock`, `UnifiedToolResultBlock` (`translate/concerns/blocks.ts`).
Adding a fifth surface later means adding one normalize + one denormalize
function in `concerns/normalize.ts` — the existing translators don't change.

## POST /v1/chat/completions (client: OpenAI Chat Completions)

- **OpenAI model** — request/response forwarded to `/chat/completions`
  as-is; no translation.
- **`claude*` model** (`translate/openai-anthropic.ts`) —
  - Request: the leading `role:"system"` message (if any) is pulled out into
    Anthropic's top-level `system` field (Chat Completions has no separate
    system field — Anthropic does). Remaining messages normalize → unified →
    `fixMissingToolResults`/`sanitizeAnthropicToolIds` (see `TOOL_CALLING.md`
    for why both run here) → denormalize to Anthropic `messages[]`. Tools,
    `temperature`, `top_p`, `stop` (renamed `stop_sequences`), and `stream`
    pass through 1:1; `tool_choice` translates via
    `concerns/tools.ts` (see `TOOL_CALLING.md`); `response_format` has no
    Anthropic equivalent and folds into `system` as a best-effort instruction
    (see `TOOL_CALLING.md`). `max_tokens` is required by Anthropic but
    optional in Chat Completions — defaults to 4096 if the client didn't
    send `max_tokens`/`max_completion_tokens`, floored to at least 4096
    whenever `tools` is present regardless of the client's value (see
    `TOOL_CALLING.md`).
  - Response: Anthropic's `content[]` blocks normalize → unified →
    denormalize into a single OpenAI `assistant` message; `stop_reason` maps
    via `concerns/finishReasons.ts`; usage normalizes via
    `concerns/cache.ts` (see `CACHING.md`).

## POST /v1/messages (client: Anthropic Messages)

- **`claude*` model** — forwarded to `/messages` as-is.
- **OpenAI model** (`translate/openai-anthropic.ts`) — the mirror image
  of the above: Anthropic `system` field becomes a leading
  `role:"system"` Chat message; Anthropic `messages[]` (mixing `user`/
  `assistant`/tool_result-as-user-block) normalizes → unified → denormalizes
  to Chat's `messages[]` (tool results become separate `role:"tool"`
  messages, per Chat Completions' shape — a result's `is_error` flag has no
  dedicated field on that shape, so it's preserved as a `[tool_error] `
  content prefix instead of being dropped; see `TOOL_CALLING.md`).
  `tool_choice` translates via `concerns/tools.ts` (see `TOOL_CALLING.md`).
  Response direction is the reverse of the chat-completions case above.

## POST /v1/responses (client: OpenAI Responses)

- **OpenAI model** (`translate/openai-responses.ts`) — forwarded to
  `/responses` as-is. This translator is same-vendor (Responses ⇄ Chat, both
  OpenAI's own vocabulary) so it maps wire shape to wire shape directly
  instead of through the unified block model — Responses' `input_text`/
  `input_image` line up 1:1 with Chat's `text`/`image_url`, with no
  provider-specific block semantics (e.g. Anthropic's separate `tool_result`
  role) to reconcile.
- **`claude*` model** (`translate/openai-responses.ts` +
  `translate/openai-anthropic.ts`, chained) — Responses has no
  Anthropic-shape equivalent, so the request goes Responses → Chat → Anthropic
  and the response goes Anthropic → Chat → Responses, reusing the
  chat-completions translators as the middle hop (so `tool_choice`
  translation, tool-result auto-repair, tool-id sanitization, and the
  tools-present `max_tokens` floor — see `TOOL_CALLING.md` — all apply here
  too, inherited through the chain; Responses has no `response_format`
  field so that fix doesn't apply on this route). `status`/
  `incomplete_details` derive from the intermediate Chat response's
  `finish_reason`, inline in `translateChatResponseToResponses` in
  `openai-responses.ts` — the same logic used for the native
  OpenAI→Responses direction above, since by this point in the chain the
  Anthropic response has already been normalized down to Chat shape.

## GET /v1/models

Merges both providers' `/models` list responses into one
`{ object: "list", data: [...] }` envelope (the shape every OpenAI-compatible
client already expects), tagging each entry `owned_by: "openai" | "anthropic"`.
A provider with no usable credentials for the request is skipped rather than
failing the whole call — see `routes/status.ts`.

## Streaming (`stream: true`)

Every route/pair combination supports streaming, including the
cross-provider ones. Rather than write 3×3 wire-format converters,
`upstream/bridge.ts` decodes every provider's raw SSE event vocabulary into
one canonical, INCREMENTAL-only `StreamEvent` sequence
(`text_delta` / `tool_call_start` / `tool_call_args_delta` / `tool_call_end` /
`finish` / `usage`), and re-encodes that sequence into any of the three
target vocabularies:

```
Anthropic SSE ─┐                     ┌─ Anthropic SSE
OpenAI Chat SSE─┼─ decode ──► StreamEvent stream ──► encode ─┼─ OpenAI Chat SSE
Responses SSE  ─┘                     └─ Responses SSE
```

Canonical events never carry a running snapshot, only deltas — tool call
`argumentsDelta` is a raw JSON string fragment, passed through without
reparsing (Anthropic's `input_json_delta` and OpenAI's
`tool_calls[].function.arguments` are both partial-JSON-string streams
already; reparsing mid-stream would throw on every incomplete chunk).

One quirk each decoder has to handle:
- **Anthropic** — `content_block_start`/`delta`/`stop` are keyed by a numeric
  `index` that's reused across blocks in a turn; `decodeAnthropicStream`
  tracks per-index block state (text vs. tool_use, and the tool's id) in a
  `Map<number, …>` to know what a given `delta`/`stop` refers to.
  Retained transiently for the request's duration only.
- **OpenAI Chat** — tool call `id` is present only on the FIRST chunk of a
  given tool call; every continuation chunk omits it. `decodeOpenAIChatStream`
  tracks currently-open tool call ids in a `Set` and keys continuation deltas
  off the most-recently-opened id.
- **OpenAI Responses** — has explicit `item_id`/`call_id` on every event, no
  such tracking needed.

`upstream/sse.ts` handles only the wire-level `event: X\ndata: Y\n\n` framing
(byte-stream → frames, frames → bytes) with zero knowledge of any provider's
event vocabulary — that split keeps `bridge.ts` protocol-agnostic and
`sse.ts` reusable if a fourth surface is ever added.
