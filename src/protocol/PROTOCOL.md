# Protocol

`src/protocol/` is the canonical↔wire translation boundary: codecs that encode
a `CanonicalRequest` into a provider's wire payload and decode wire responses
(JSON or SSE) back into `CanonicalEvent`s. The canonical model itself
(`WireFamily`, `CanonicalRequest`, `CanonicalEvent`) lives in
`src/transport/canonical-model.ts`, and the typed gateway failures
(`GatewayError`, its stable codes, the public-detail sanitizers) live in
`src/transport/gateway-error.ts` — protocol depends on both, never duplicates
either. SSE framing lives in `src/transport/streaming.ts`; retry classification in
`src/transport/failure-policy.ts`. Provider identity, adapters, and dispatch
context live in `src/providers/`; client-facing surface parsing lives in
`src/transport/surface/`.

Placement is enforced by `test/architecture/protocol-naming.test.ts`: the
canonical `src/protocol/{request,response,transport}` directories must exist,
old provider-local protocol paths must not, and no source file may import a
removed protocol path.

## Layout

```text
src/protocol/
  PROTOCOL.md             this file
  registry.ts             dispatcher: encodeWireRequest / decodeWireResponse / decodeWireStream + CodecContext
  primitives.ts           shared guards, UTF-16 coercion, tool-id normalization, Codex ids/effort,
                          Harmony escaping, endpoint/header/auth helpers, image-source resolution
  messages-errors.ts      Claude HTTP + SSE error mapping (single status→code table)
  stream-error-frames.ts  in-stream error frame → typed GatewayError, shared by chat/responses/codex
  request/chat.ts         canonical → OpenAI Chat payload
  request/responses.ts    canonical → OpenAI Responses payload
  request/messages.ts     canonical → Anthropic Messages payload
  request/codex.ts        canonical → Codex Responses payload (direct entry, not via registry)
  request/gemini.ts       canonical → Gemini payload (direct entry)
  response/chat.ts        Chat JSON/SSE → canonical events
  response/responses.ts   Responses JSON/SSE → canonical events
  response/messages.ts    Claude JSON/SSE → canonical events
  response/codex.ts       Codex frames → canonical events (stateful frame processor)
  response/gemini.ts      Gemini helpers (candidate/parts/usage/stop-reason/stream-event)
  transport/openai.ts     shared upstream JSON POST executor (deadline/abort lifecycle)
  transport/messages.ts   shared Claude request sender (status-first errors, SSE vs JSON branch)
```

## Registry (dispatcher)

`registry.ts` is the only entry point generic adapters use
(`providers/compatible-adapter.ts`: `preparePayload` → `encodeWireRequest`,
`transformStream` → `decodeWireStream` / `decodeWireResponse`):

- `encodeWireRequest(wireFamily, request, CodecContext)` → chat / responses /
  messages builders. Throws on anything else — including `"native"`.
- `decodeWireResponse(wireFamily, json, request, context)` → per-family
  JSON parsers.
- `decodeWireStream(wireFamily, body, request, context)` → per-family SSE
  decoders.
- `CodecContext`: `isOAuth`, `sessionId`, `supportsPromptCaching`, `signal`.

Codex and Gemini do **not** go through the registry; they expose dedicated
builders/parsers called directly by their adapters
(`integrations/codex/codex.ts`, `integrations/gemini.ts`,
`integrations/antigravity/antigravity.ts`).

## Request codecs (canonical → wire)

- `request/chat.ts` — `canonicalToChatPayload(request,
  supportsPromptCaching)`: system/instructions → `system`/`developer` messages;
  assistant tool calls → `tool_calls`; Messages-ledger tool results → `role:
  "tool"` with `[tool_error]` prefix; rich content → multipart (`image_url`,
  `input_audio` with MIME→`wav`/`mp3` map, `file`, document→`file`);
  `reasoning_content` side channel; prompt-cache breakpoints; tools /
  `tool_choice` (incl. `custom`, `allowed_tools`); `response_format` envelope;
  top-level `reasoning_effort`; `stream_options`, `modalities`, `audio`,
  `metadata`, `user`, plus `extension:*` passthrough.
- `request/responses.ts` — `canonicalToResponsesPayload` +
  `markLatestResponsesCacheBreakpoint`: system/instructions → message items;
  tool calls/results → `function_call` / `function_call_output` (never
  swallowed into bare messages); `computer_call` / `computer_call_output` with
  `pending_safety_checks` restored from `extension:responses.item_metadata`;
  encrypted reasoning replay; `previous_response_id` / `conversation` /
  `metadata`; `reasoning{effort,mode,context,summary}`; `text{verbosity,format}`;
  `extension:responses.*` passthrough.
- `request/messages.ts` — `canonicalToClaudeMessagesPayload(request,
  { isOAuth })`: system/developer hoisting to top-level `system`; `tool` role
  → `user`; stable-partition trailing `tool_use`; sampling-param strip when
  thinking is enabled; `stop_sequences` cap 4; `thinking{type,budget_tokens,
  display,block_binding}` + default `context_management`;
  `output_config{effort,task_budget}`; `container`, `inference_geo`,
  `service_tier`, OAuth tool-name prefixing.
- `request/codex.ts` — `canonicalToCodexResponsesPayload(request,
  { responsesLite, concurrentReasoningSummaries })` +
  `applyCodexResponsesLiteShape`: owns orphan tool-exchange repair (synthesize
  placeholder result / fold orphan result to a user note), `__`-composite tool
  ids, encrypted/summary reasoning items, Harmony escaping gated on
  `gpt-oss`/`gpt-5`, `reasoning{effort,summary,mode,context}` + forced
  `include: ["reasoning.encrypted_content"]` when reasoning is present,
  `prompt_cache_key` derived from the caller's `cache_hint`, forced
  `stream:true, store:false`. The Codex adapter then overwrites that key with
  the session id (`request.session_id ?? resolvePromptCacheKey(request)`), and
  `resolvePromptCacheKey` is what unifies chat, responses, and messages caller
  keys into one affinity, so switching wires does not miss the upstream cache.
  Client IP is never part of it. Lite shape strips image `detail`, sets
  `parallel_tool_calls:false`, hoists `tools` → leading `additional_tools`
  developer item, downgrades hosted `tool_choice`.
- `request/gemini.ts` — `buildGeminiPayload` + `geminiModelUrl`: `contents`
  (assistant→`model`, tool→`user`), `systemInstruction`,
  `functionDeclarations` with Gemini schema sanitizer (`const`→`enum`,
  `type:null`→`nullable`, prune unknown `required`, empty-array `items`),
  `generationConfig{maxOutputTokens, thinkingConfig}` with thinking output
  floors.

## Response codecs (wire → canonical events)

Shared conventions: per-family stop-reason mappers, split-usage merge
(keep latest totals, keep max `cached_tokens` for the xAI split-usage pattern,
tolerate `usage:null`), tool-identity resolution with orphan fallbacks,
duplicate suppression via the tool-emit ledger (chat/responses) and
per-index/per-item identity maps (messages/codex), empty-delta suppression,
and a hard rule — a stream with **no terminal envelope fails** (`failed`),
never bills as success.

- `response/chat.ts`: per-index tool-id/name memory, `reasoning_content` →
  reasoning parts, audio → `extension:audio`, `[DONE]` terminal, missing
  `finish_reason` → `failed`.
- `response/responses.ts`: `output_text`, reasoning (summary +
  `encrypted_content`), `function_call`, `computer_call` /
  `computer_call_output`, unknown item/event types → `extension:responses:*`;
  argument-delta identity by `item_id` → `output_index` → last-seen → orphan
  id; the terminal lifecycle frames it names (`created` / `in_progress` /
  `completed` / `incomplete` / `failed`) drive status/usage only — every other
  event type, including lifecycle frames it does not name, becomes
  `extension:responses:*` content.
- `response/messages.ts`: `message_start` + `message_delta` usage merged so
  cache accounting survives; `redacted_thinking` → opaque reasoning;
  `server_tool_use` / `search_result` → extension; `error` frames →
  `mapClaudeStreamError`; requires `message_stop`, else 502.
- `response/codex.ts`: stateful `CodexStreamFrameProcessor` + `terminalEvent()`;
  `in_progress`/`queued` → `stop`, `completed` + tools → `tool_use`,
  `incomplete` + tools → `tool_use`, `failed`/`cancelled` → `error`/`aborted`;
  whitespace-loop guard → `tool_call_loop_detected`.
- `messages-errors.ts`: `mapClaudeHttpError` (status + JSON envelope →
  `GatewayError`; 429 gets `rateLimitScope: provider`, 401/403 get
  `credentialEvidence`) and `mapClaudeStreamError` share one status→code table.
- `stream-error-frames.ts`: `gatewayErrorFromStreamError` classifies an explicit
  error envelope that arrives *inside* a `200 OK` body — the shape that is not a
  transport failure because the status already committed. Shared by the chat,
  responses, and codex decoders (the Claude and Gemini decoders raise on their
  own). Reads structured identifiers only (`error.type`, `error.code`, a numeric
  `error.status`): a rate-limit identifier → `quota_exceeded` (429,
  provider-scoped), an overload identifier → `platform_unavailable`, an auth
  identifier → `authentication_failed` with `credentialEvidence`, a named
  overflow → `context_length_exceeded`. A frame that declares a failure with
  nothing recognizable becomes `platform_unavailable`, never `invalid_request` —
  blaming the client for the provider's problem invites an identical retry. A
  frame discriminator (`type: "error"`, `response.failed`) is not read as an
  error identifier, or it would shadow the real `code`. Prose is never matched;
  a decoder's own `catch` must rethrow a `GatewayError` unchanged.

## Shared primitives

`primitives.ts` is the single home for cross-codec helpers: wire guards
(`object`, `stringValue`, `finiteNumber`, `readString`/`readNumber`/
`readBoolean`), UTF-16 well-formedness, Anthropic tool-id normalization
(composite `|` split, invalid-char → `_`, 64-char cap with hash suffix,
`_dupN` dedup), `sanitizeSchemaForAnthropic` (allowlisted schema keys),
OAuth tool prefixing (`CLAUDE_TOOL_PREFIX = "_"`), billing-attestation drop,
Codex ids/effort/session state, Harmony escaping (gpt-5/gpt-oss only),
`joinUrl`/`endpointUrl` (OAuth `?beta=true`), `BUILTIN_DEFAULT_ENDPOINTS`,
`normalizeBearerToken`, `filterProviderCustomHeaders` (RFC-token name, 4 KiB
value cap, control-char reject, protected-name reject — protection list
imported from `src/security/outbound-headers.ts`), `resolveImageSource` (Chat /
Responses / Anthropic origin shapes), hash/JSON helpers.

## Upstream executors

- `transport/openai.ts` — `postUpstreamJson()`: POST with the
  deadline/abort lifecycle from `providers/operations/upstream-deadline.ts`;
  abort → `transport_closed` 499. Used by `CompatibleAdapter.executeTransport`.
- `transport/messages.ts` — `sendClaudeMessagesRequest()`: status-first error
  mapping, SSE vs JSON branch. Shared by the Claude and Anthropic adapters.

## How to extend

- **New wire family**: add request encoder + response decoder + registry case
  + stop-reason map + tests; `provider_stop_reason` stays diagnostics-only and
  must never leak across families.
- **New Codex/Gemini behavior**: extend the direct builders/parsers, not the
  registry — those families intentionally bypass it.
- **New shared helper**: put it in `primitives.ts` when two or more codecs
  need it; keep provider-identity-dependent helpers (e.g. Codex identity
  headers) with their provider.
