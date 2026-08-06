# Protocol Translation & Response Shaping

**How Cartethyia normalizes every client surface into one canonical contract, dispatches to the provider's native wire surface, and translates responses back to the client's requested surface — preserving text, reasoning, tool calls, usage, stop reasons, and refusals.**

---

## Why this exists

Cartethyia is an HTTP proxy and control plane, not a provider SDK. A single request can arrive on any of four public surfaces and route to any provider whose protocol differs:

| Client surface (endpoint) | Provider wire surface |
|---|---|
| `/v1/chat/completions` → `openai-chat` | `openai-chat`, `anthropic-messages`, `openai-responses`, `images` |
| `/v1/responses` → `openai-responses` | `openai-chat`, `anthropic-messages`, `openai-responses`, `images` |
| `/v1/messages` → `anthropic-messages` | `openai-chat`, `anthropic-messages`, `openai-responses`, `images` |
| `/v1/images/generations`, `/v1/images/edits` → `images` | `images` (image-capable providers) |

Even a same-format call (**openai→openai, anthropic→anthropic**) funnels through this shared canonical representation, so protocol behavior stays in one place instead of being duplicated per provider.

---

## Request path: surface detection → normalization

`src/domain/protocols/surface.ts`

### 1. Endpoint-driven surface detection

```ts
detectSurface(endpoint: ProxyEndpoint): ProviderSurface | null
```

- `/v1/chat/completions` → `openai-chat`
- `/v1/messages` → `anthropic-messages`
- `/v1/responses` → `openai-responses`
- `/v1/images/generations` | `/v1/images/edits` → `images`
- `/v1/models` → `null` (no request body)

### 2. Body-shape detection (dispatch fallback)

`detectProtocolFromBody(body)` is used when the endpoint is unknown or ambiguous (batch/NDJSON routing, tests). The endpoint mapping is authoritative; this returns `null` for genuinely ambiguous plain text conversations.

```ts
input|instructions present           → openai-responses
no `messages` array                  → null
`system` present                     → anthropic-messages
response_format|max_completion_tokens→ openai-chat
role system|developer|tool           → openai-chat
tool_calls in a message              → openai-chat
content block image_url              → openai-chat
content block image|tool_use|thinking→ anthropic-messages
```

### 3. Normalization

```ts
normalizeRequest(endpoint, body, input): NormalizeResult
```

Each surface has its own validator/normalizer producing the canonical `NormalizedProviderRequest`:

- `normalizeChatRequest` — `openai-chat`
- `normalizeMessagesRequest` — `anthropic-messages`
- `normalizeResponsesRequest` — `openai-responses`
- `normalizeImageRequest(body, input, "generate"|"edit")` — `images`

Key invariants:
- Exactly one JSON object per request body; **NDJSON/batch multi-object bodies are rejected** (batch framing is a transport concern — one request per HTTP call).
- Oversize bodies fail typed (`maxBodyBytes` bound).
- `stream` is carried by a narrowed boolean; stream/non-stream semantics stay visible to routing.

---

## Dispatch: choosing the wire surface

`src/domain/protocols/translation.ts`

```ts
wireSurfaceFor(metadata, capabilities, clientSurface): ProviderSurface | null
```

Selection rule (protocol-agnostic, never "compare provider names"):

1. `clientSurface === "images"` → keep `images` only if the provider declares image surface, else `null`.
2. Provider already supports the client surface → use it as-is.
3. `protocol === "anthropic"` → prefer `anthropic-messages`.
4. `protocol === "gemini"` → prefer `openai-chat`, else first non-`images` surface.
5. Otherwise → prefer `openai-chat`, else `openai-responses`, else `null`.

Returns `null` only when no compatible surface exists → routing reports `capability_unsupported`.

---

## Response path: non-streaming translation

`translateNonStreamResponse(body, protocol, wireSurface, clientSurface)`

If the wire surface already equals the client surface (or it's an image call, or a Gemini call), the body passes through unchanged. Otherwise it is converted through canonical chat-shape bridge functions:

```
anthropic ⇄ chat ⇄ responses
```

| Wire → Requested | Conversion |
|---|---|
| `anthropic-messages` → `openai-chat` | `anthropicToChat(body)` |
| `anthropic-messages` → `openai-responses` | `anthropicToChat` → `chatToResponses` |
| `openai-responses` → `openai-chat` | `responsesToChat(body)` |
| `openai-responses` → `anthropic-messages` | `responsesToChat` → `chatToAnthropic` |
| `openai-chat` → `anthropic-messages` | `chatToAnthropic(body)` |
| `openai-chat` → `openai-responses` | `chatToResponses(body)` |

### What the bridge functions preserve

- **Text content**: string `content` and structured `content` blocks both collapse/expand correctly.
- **Reasoning / thinking**:
  - chat `reasoning_content` → anthropic `thinking` block, and → responses `reasoning` item with `summary_text`.
  - anthropic `thinking` → chat `reasoning_content`.
- **Tool calls**:
  - chat `tool_calls[]` → anthropic `tool_use` blocks, → responses `function_call` items.
  - responses `function_call` → chat `tool_calls[]` (with `finish_reason: "tool_calls"`).
- **Usage**:
  - chat `prompt_tokens`/`completion_tokens`/`total_tokens` ⇄ responses `input_tokens`/`output_tokens`/`total_tokens`.
- **IDs & timestamps**: `chatcmpl-*` ↔ `resp_*` prefixed; `created`/`created_at` synchronized.
- **Stop reason**: chat `finish_reason` `tool_calls` mapped when tool calls present, else `stop`.

> All conversions are pure functions — no network, no persistence, deterministic and unit-testable.

---

## Response path: streaming (SSE / NDJSON)

`src/domain/protocols/stream.ts` + canonical `StreamEvent` in `src/domain/contracts.ts`

### Canonical `StreamEvent` vocabulary

Every upstream stream is decoded through a **mapper** into one shared event set, then re-encoded to the client's requested surface.

```ts
type StreamEvent =
  | { type: "message_start";    id: string }
  | { type: "thinking_delta";   text: string }
  | { type: "text_delta";       text: string }
  | { type: "tool_call_start";  callId: string; name: string }
  | { type: "tool_call_delta";  callId: string; delta: string }
  | { type: "tool_call_end";    callId: string }
  | { type: "usage";            usage: ProviderUsage }
  | { type: "message_stop";     reason: StopReason }
```

`StopReason = "completed" | "length" | "tool_call" | "content_filter" | "error"`

The terminal event is `message_stop` (`isTerminalEvent`). **Tool-call deltas are correlated by the wire's `index` field, never "the last opened id"** — this is what makes parallel tool calls in agentic clients (Claude Code, Copilot, OpenCode) route correctly.

### Framing & decoding layers

```
bytes ─► decodeUtf8Lines    (UTF-8 across chunk boundaries, fatal on malformed,
                              bounded maxLineBytes, strips CRLF, writer abort)
        ─► decodeSseRecords / decodeNdjsonRecords
        ─► mapper(record)   (protocol-specific → StreamEvent | StreamEvent[] | null)
        ─► decodeStream      (requires terminal event unless requireTerminal=false)
```

- `maxLineBytes` default `1 MiB`, per-event bound default `4 MiB` (`DEFAULT_STREAM_LINE_BYTES`/`DEFAULT_STREAM_EVENT_BYTES`).
- Malformed UTF-8, over-long lines, malformed JSON/NDJSON records → typed `StreamDecodeError`.
- A stream ending without a terminal event fails as `stream_truncated` (never retryable).
- `createStreamDecoder(options)` bundles framing + mapper + terminal validation into the app `StreamDecoder` contract.

### Per-surface encoding

The canonical event sequence is re-encoded with the **surface encoder** matching the client's requested surface:

- `openai-chat` → `chat.completion.chunk` SSE events; `tool_call_start`/`delta`/`end` become `delta.tool_calls[]` chunks keyed by index.
- `anthropic-messages` → `message_start` / `content_block_start` / `thinking_delta` / `text_delta` / `content_block_stop` / `message_delta` / `message_stop` events. `thinking_delta` maps to a `thinking` block, and Anthropic's per-block cryptographic `signature` is carried via `reasoning_signature` / `thinking_signature` so replay validation passes on the next turn.
- `openai-responses` → `response.created` / `response.output_item.added` / `response.content_part.added` / `response.output_text.delta` / `response.function_call_arguments.delta` / `response.completed` SSE events.
- `images` → non-stream image result (no incremental text stream).

### Retry gate ("meaningful output")

`src/app/recovery.ts` treats only `text_delta`, `thinking_delta`, `tool_call_start`, `tool_call_delta` as meaningful output. If a stream is aborted before any meaningful event, it's eligible for retry/failover; once meaningful output flows, it is not (prevents duplicate side effects).

---

## Usage normalization

`src/domain/protocols/measure.ts` + `ProviderUsage`

Every request records canonical usage so telemetry, quota, and account health stay consistent regardless of upstream protocol:

```ts
interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;   // cache read (prompt caching)
  cacheWriteTokens: number | null;  // cache write (prompt caching)
}
```

- **Upstream-provided**: parsed from `usage.prompt_tokens`/`completion_tokens`/`total_tokens` (chat), `usage.input_tokens`/`output_tokens` (responses), or Anthropic's `usage.input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`.
- **Estimated**: when the provider omits usage, a tokenizer estimate is used (`UsageSource: "provider" | "tokenizer" | "unknown"`).
- First-token time & streamed usage are recorded on the request telemetry.

---

## Error & refusal translation

- **Protocol conversion failures** use `ProtocolCodecError` (typed, non-retryable, sanitized).
- **Provider/transport failures** use the provider-call error contract (`ProviderCallError`): typed kind, `retryable`, `routeScope`, `detached` `retryAt`, and a **sanitized** message.
- **Stream decode failures** (`StreamDecodeError`) convert to `ProviderCallError` via `toProviderCallError()`; never retryable by default.
- **Safety refusals** map to `content_filter` stop reason and are surfaced on the requested surface without leaking raw upstream body.
- No fake `Cartethyia`/`claude-code`/other upstream `User-Agent` is ever added; a client header is forwarded only when the adapter explicitly permits it.

---

## Guarantees (AGENTS.md protocol rules)

1. Normalize every client surface into `NormalizedProviderRequest`.
2. Route using capabilities + `wireSurfaceFor`; never compare provider names.
3. Preserve the requested client surface on the way back.
4. Non-streaming responses translate through the shared protocol boundary.
5. Streaming responses use canonical `StreamEvent` + the requested surface encoder.
6. Preserve text, reasoning, tool calls, usage, stop reasons, refusal/error where the surface supports them.
7. `ProtocolCodecError` for conversion; provider-call error contract for provider/transport.
8. Never duplicate an existing protocol codec as a provider-specific copy.

---

## Related

- `docs/model-catalog.md` — pricing/context metadata used to gate capability checks
- `docs/alias-routing.md` — how aliases/combos inherit metadata resolved here
- `src/domain/protocols/` — surface detection, translation, stream framing, usage measure
- `src/app/request.ts` / `src/app/response.ts` — dispatch lifecycle & stream terminal handling

