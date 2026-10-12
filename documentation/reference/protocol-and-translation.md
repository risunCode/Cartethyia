# Protocol and translation

How one client payload becomes one provider payload and back. Read this before
changing request or response handling. For the procedure to attribute a failing
request to one field, use the
[trace-replay skill](../../.skills/cartethyia-trace-replay/SKILL.md) instead —
this file explains the seams, not the bisection method.

## What the gateway translates between

The gateway exposes four client request surfaces. Each surface parses into the
canonical request; `completions` has its own legacy parser and client-response
encoder, but no dedicated provider-side codec. It is translated to the selected
provider wire family like the other surfaces.

| Client surface | Path | Owner |
| --- | --- | --- |
| Chat Completions | `/v1/chat/completions` | `src/transport/surface/chat/` |
| Responses | `/v1/responses` | `src/transport/surface/responses/` |
| Messages | `/v1/messages` | `src/transport/surface/messages/` |
| Completions | `/v1/completions` | `src/transport/surface/completion.ts` |

Each adapter implements `SurfaceAdapter` (`src/transport/surface/adapters.ts:51`):
`matchesBodyShape` for detection, `parse` for inbound, and `encode`/`encodeOutput`
for outbound. The registry is built once in `src/boot/app.ts:174`.

Detection is once-only with fixed precedence — explicit `x-cartethyia-surface`
header, then endpoint path, then an unambiguous body shape, then chat as the
permissive default (`src/transport/surface/adapters.ts:129`). Path wins over body
shape on purpose: user-agent sniffing and prompt-text scanning never influence
routing. Every signal is evaluated even after one wins, because the losing
signals are what `disagreement` reports. A path-vs-body disagreement is normal
traffic, not a fault — a chat body with `max_tokens` also matches the Messages
shape — so only a marker-vs-path conflict is logged at warn
(`src/transport/guards/request-context.ts:194`).

Codex and Gemini are client-visible only through their providers, not as public
surfaces: `src/protocol/request/codex.ts`, `src/protocol/response/codex.ts`, and
`src/protocol/request/gemini.ts` / `response/gemini.ts` are consumed by
`src/providers/integrations/codex/codex.ts:40` and
`src/providers/adapters/gemini.ts:15`.

Three wire families exist on the provider side — `chat`, `responses`, `messages`
(`src/protocol/canonical-model.ts:8`). There is no `native` family. A provider
that frames its own bytes says so on its metadata (`bespokeWire`,
`src/providers/metadata.ts:316`), which is what exempts it from the codec
matrices in `src/transport/translation/capabilities.ts:175`.

## The canonical model

`src/protocol/canonical-model.ts` holds the vocabulary both sides encode from:
`CanonicalRequest` (:472), `ContentPart` (:216), `CanonicalEvent` (:346),
`CanonicalTerminalEvent` (:320), and `UsageRecord` (:429).

The canonical form exists so policy has one input. Routing, capability
preflight, degradation, tool repair, quota, admission, and telemetry all read
`CanonicalRequest` and never see a wire body. Adding a client field costs one
canonical field plus the codecs that carry it; adding a provider costs one codec
pair. Without a canonical form each client surface would need an N-way
translation table per provider, and a chat client could never be served by a
Messages account.

Two decisions in the model carry most of the weight:

- **Stop reasons are canonical.** `CanonicalStopReason` (:304) is mapped from the
  provider's own vocabulary by the response decoders and mapped back into the
  client's by the surface encoders. The raw provider string survives on
  `provider_stop_reason` (:330) for diagnostics, and encoders must not switch on
  it — that is what keeps one protocol's stop vocabulary out of another's
  response.
- **Tool results live in `tool` *or* `user` turns.** The Messages ledger re-homes
  tool results into `user` turns, so `canContainToolResult` (:190) is the
  predicate, not `role === "tool"`. Testing the role directly is how broken tool
  sequences reached upstream.

Values with no stable intersection across wires stay opaque: `extension` content
parts, `reasoning` payloads, and `GenerationControls` keys prefixed
`extension:` (:127). Reasoning is one canonical part whether the client sent a
thinking block, `reasoning_content`, or a Responses reasoning item. Empty
reasoning is preserved, never invented.

## Request path

Client payload → canonical → upstream payload, in three stages.

**Parse.** `createCanonicalRequestMiddleware` picks the surface adapter and calls
`parse` (`src/transport/guards/request-context.ts:227`). It reads the body the
ingress policy already decoded — never a second read. Dialect-specific field
precedence lives in `src/transport/surface/dialects.ts`: `parseToolDefinition`
(:17), `parseToolChoice` (:160), `parseReasoningIntent` (:202),
`parseResponseFormat` (:237). Shared content normalization is in
`src/transport/surface/content-parts.ts:47` (the `data:` URI split) and
`src/protocol/codecs.ts`.

**Prepare.** `ProxyRequestPreparer.prepare` (`src/transport/request/preparer.ts:75`)
runs everything that needs no knowledge of the chosen provider: the `model(high)`
thinking suffix is stripped before anything matches on the model name (:101),
alias and CLI remapping resolve the target
([alias and combo resolution](../features/routing-aliases-combos.md),
[CLI model mapping](../features/cli-model-mapping.md)), corrupt attachments are
dropped (:155), capabilities are derived and the plan is built, degraded
variants are tried when nothing supports the full request (:174), tool rounds
are repaired (:281), and the request is projected onto the winning candidate
(`projectForRoute`, `src/transport/translation/capabilities.ts:375`). Projection
throws `capability_unsupported` rather than silently dropping semantics. The
attempt loop re-projects per candidate in
`src/transport/dispatch/proxy-request.ts:238`.

**Encode.** `BaseProviderAdapter.dispatch` (`src/providers/base-adapter.ts:22`)
calls the adapter's `preparePayload`, which for the OpenAI-compatible family
calls `encodeWireRequest` (`src/protocol/registry.ts:16`) → one of
`canonicalToChatPayload` (`src/protocol/request/chat.ts:177`),
`canonicalToResponsesPayload` (`request/responses.ts:59`), or
`canonicalToClaudeMessagesPayload` (`request/messages.ts:362`). Bespoke adapters
call their own builder: `canonicalToCodexResponsesPayload`
(`request/codex.ts:117`), `buildGeminiPayload` (`request/gemini.ts:242`).

Per-provider quirks are declarative, not scattered `delete payload.x` calls.
`src/transport/translation/quirks.ts` holds `PARAM_QUIRKS` (:145) — a provider id,
an optional model matcher, and the strip/clamp — applied by `applyParamQuirks`
(:175) before wire translation. Add a row only when a concrete upstream 400/422
proves it. Output-token bounds per wire are one table, `WIRE_TOKEN_BOUNDS` (:76),
resolved by `resolveWireMaxTokens` (:83), so the three codecs cannot drift; each
builder calls it (`request/chat.ts:518`, `request/responses.ts:319`). Cache
breakpoint marking is shared in `src/transport/translation/cache-controls.ts`
because the marker differs per wire but the scan does not.

## Response path

Upstream bytes → `CanonicalEvent` stream → client wire.

Adapters yield canonical events from `transformStream`
(`src/providers/compatible-adapter.ts:293`). SSE bodies go through
`decodeWireStream` (`src/protocol/registry.ts:53`); JSON bodies through
`decodeWireResponse` (:35). Every SSE decoder sits on the shared
`decodeSseEvents` (`src/protocol/sse-decoder.ts:63`), which is bounded, abort
aware, and strict — a malformed line is a 502 with `origin: "upstream"`, because
a corrupt stream must never decode as valid deltas.

The event vocabulary is small: `message_start`/`response_start`, `content_delta`,
`tool_call_delta`, `tool_result`, `usage`, `keepalive`, `error`, and exactly one
`terminal` (`src/protocol/canonical-model.ts:346`). `canonicalTerminal`
(`src/protocol/codecs.ts:637`) is the single builder, so an absent optional is
omitted rather than emitted as `undefined`. Streamed tool calls keep one id across
deltas through `src/protocol/tool-identity.ts`, whose `claimFirstEmission` (:139)
is the only gate for call-defining events — a duplicate reaches the client zero
times by construction.

**Client encoding.** Streaming frames come from `StreamEventPipeline`
(`src/transport/dispatch/streaming/encoder.ts:36`), which owns the surface
encoder, the terminal event, usage, and the first-byte/first-content timestamps
that finalization reads. `createDispatchStreamEncoder`
(`src/transport/dispatch/stream-bridge.ts:21`) picks the framing per surface:
chat and completion get unnamed `data:` frames plus an explicit `[DONE]`
sentinel, Responses get named `event:` frames, Messages get named frames with a
nested `error` object. The `[DONE]` sentinel and the error frame are emitted by
the bridge, never by an encoder (`src/transport/surface/stream-frame.ts:22`).
Non-streaming responses are encoded by the surface adapter directly
(`src/transport/dispatch/proxy-request.ts:351`).

**Usage.** Canonical `UsageRecord` keeps the cache split explicit —
`cached_input_tokens`, `cache_write_tokens`, `uncached_input_tokens` — and each
is `number | "unavailable"` (:426), never a silent zero. Providers that repeat
usage across lifecycle frames are merged by taking the largest cached count
rather than the last one (`src/protocol/response/responses.ts:63`). The terminal
event's usage wins; a stream with none falls back to
`estimatedUsage(input, output)` (`src/transport/dispatch/attempt-finalize.ts:363`),
whose `estimated_cost` is `null`, not `0` — unpriced is not free, and the
console's `partial` flag depends on that distinction. `repriceUsage`
(`src/providers/usage.ts:98`) applies the routed model's catalog rate before the
record is committed, then the wire converters (`usageToChatWire` :357,
`usageToResponsesWire` :385, `usageToMessagesWire` :411) render it per surface.

## Error mapping

A provider failure becomes a client-visible error at one of two boundaries, and
both produce the same `GatewayError` so the classification cannot disagree.

`mapUpstreamHttpError` (`src/transport/failure-policy.ts:718`) turns a failed
HTTP response into a typed error, reading a machine-readable identifier via
`upstreamErrorIdentifier` (:586) before falling back to status alone through
`classifyUpstreamError` (:622). Prose is only consulted to recognize an overflow
that names both the measured size and the window (`isContextLengthFailure` :524),
never as a substring rule. `src/protocol/stream-error-frames.ts:46` applies the
same classifier to an error envelope that arrived *after* a 200 status line — a
streaming failure that used to reach telemetry as `unknown_error`. Claude has its
own mapper for the same reason (`src/protocol/messages-errors.ts:56`).

Every error carries `code`, `status`, `origin`, and `details`. Origin is
`cartethyia`, `upstream`, or `network`, and it matters: a corrupt SSE stream
labelled `invalid_request` told the client its request was wrong and invited a
retry against a broken upstream. `classifyUpstreamFailure` (:306) decides
retryability and account health from that same record, so failover and the
account cooldown never disagree about what happened.

Public text goes through `formatPublicErrorMessage`
(`src/protocol/gateway-error.ts:122`): the code travels in `error.code`, not
prefixed into the sentence. `publicGatewayErrorDetails` (:187) is an allowlist —
`PUBLIC_ERROR_DETAIL_KEYS` at :140 — so an upstream payload cannot leak into the
envelope. `createErrorNormalizationMiddleware`
(`src/transport/guards/error-lifecycle.ts:56`) is the single serializer for
everything thrown on `/v1/*` and `/console/api/*`, mounted globally.

Surface-level protocol failures are typed subclasses rather than bare strings:
`MessagesLedgerError` (`src/transport/surface/messages/errors.ts:4`) for a tool
ledger mismatch, `ResponsesSequenceError` and `ResponsesLifecycleError`
(`src/transport/surface/responses/errors.ts:15`, `:23`) for sequence and
lifecycle violations.

## Where to change what

| Change | Start here |
| --- | --- |
| New client request field | `protocol/canonical-model.ts`, then the surface `parse` + `dialects.ts`, then every codec that must carry it |
| New client response field | the surface encoder (`surface/*/encode.ts` or `messages/stream.ts`), and the decoder that must produce the event |
| New wire family | `canonical-model.ts` (`WIRE_FAMILIES`), `protocol/registry.ts`, a `protocol/request/*` + `protocol/response/*` pair, `capabilities.ts` matrices |
| Provider rejects a control combination | `transport/translation/quirks.ts` (one row, only with a proven 400/422) |
| Output-token floor/ceiling differs per wire | `WIRE_TOKEN_BOUNDS` in `quirks.ts`, then the builder that calls `resolveWireMaxTokens` |
| Capability not granted to a route | `capabilities.ts` (`routeCapabilitiesFor`, `deriveRequiredCapabilities`) and the snapshot profile in `routing/route-catalog.ts` |
| Tool-call ids or indexes disagree across frames | `protocol/tool-identity.ts`, then `transport/translation/tool-repair.ts` |
| Upstream error lands with the wrong code | `transport/failure-policy.ts` (`classifyUpstreamError`), plus `protocol/stream-error-frames.ts` for in-stream cases |
| Public error envelope shape | `protocol/gateway-error.ts`, then `transport/guards/error-lifecycle.ts` |
| Usage or cost is wrong | decoders → `UsageRecord`; pricing is `repriceUsage` in `providers/usage.ts` |
| Streaming frames or `[DONE]` | `dispatch/stream-bridge.ts`, then the surface encoder |
| Surface detected as the wrong family | `transport/surface/adapters.ts` (`SURFACE_DESCRIPTORS`, `detectOnce`) and the adapter's `matchesBodyShape` |

## Not covered here

Reproducing a failure, bisecting a payload, remote debugging against a live
gateway, and proving a test locks the fix are owned by the
[trace-replay skill](../../.skills/cartethyia-trace-replay/SKILL.md). Routing,
eligibility, leases, and account cooldowns are covered by the
[architecture reference](architecture.md) and
[health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md).
Provider registration and catalogs are covered by the
[backend reference](backend.md) and
[provider-catalog skill](../../.skills/cartethyia-provider-catalog/SKILL.md).
