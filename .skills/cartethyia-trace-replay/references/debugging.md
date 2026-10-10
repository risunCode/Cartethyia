# Debugging and live verification

Use for dispatch failures, routing bugs, wire/encoding issues, or inconsistent telemetry.

## Diagnose first

Record the request id, surface, provider/model, stream mode, status, error category,
origin, and whether the client saw content. Read current source before guessing.
Use payload tracing when retained; otherwise reproduce the shape without secrets.

## Dispatch and routing

- Follow the request from ingress → preparation → route selection → attempt loop →
  provider adapter → response encoder.
- Distinguish client cancellation, gateway deadline, upstream rejection, network
  failure, and provider response parsing.
- Check the selected provider/model against the route snapshot and catalog.
- A retry must preserve the original request contract and release leases/resources.

## Wire and tool calls

Compare the actual client payload, translated provider payload, raw provider response,
and client output. For streaming, inspect event order, terminal frame, usage, and
reasoning/tool-call association. Do not infer a payload shape from a UI label.

For duplicate tools, inspect request history, tool-call ids, retry boundaries, and
whether the adapter emitted or replayed the same call. For image failures, verify
media type, encoding, and the provider's accepted field shape.

Wire normalization lives in `src/transport/translation/quirks.ts`
(`resolveWireMaxTokens`): a positive caller value below `minTokens: 16` is
lifted to 16 for chat/responses/messages before tool-floor/ceiling clamps, and
the responses builder bounds `max_output_tokens` through the same resolver.
Tool schemas are normalized at canonical decode — `parseToolObject` in
`src/transport/surface/dialects.ts` runs `completeRequiredSchema`, so every
codec (chat/responses/messages) emits `required` matching `properties`.

## Live verification

Use the real running gateway and the same full user-agent/client headers as the
reported request. Do not curl providers directly without an explicit safe,
authorized probe; provider traffic is sensitive. Never print credentials, tokens,
or full payloads containing secrets.

A temporary reproduction must call the real pipeline, state its cleanup, and be
removed afterward.

## In-flight requests

The registry is owned by `ProxyRequestStateStore`; `state.cleanup()` is the single
idempotent release point. Streaming cleanup must cover normal completion, errors,
cancel, client abort, deadline/stall abort, and iterator return. A pending pull owns
its terminal outcome; do not release twice. The periodic backstop releases overdue
state that a disconnect shape failed to tear down.

Diagnose with the live in-flight endpoint and a real streaming reproduction that stops
reading before aborting. Confirm the gauge returns to zero and leases/slots release.

## Reasoning replay

Messages thinking blocks, chat `reasoning_content`, and Responses reasoning items are
one canonical reasoning part. Preserve presence even when text is empty; never
fabricate an empty field. Keep reasoning on assistant/tool-call turns, and handle
both Responses summary/content text fields and both streaming delta event names.

Inline `<think>` and `<thinking>` tags can straddle SSE chunks. The chat decoder and CommandCode adapter keep that state across chunks; a per-chunk regex leaks the tag boundary into answer text and makes every client surface look interrupted.

Read the captured request shape before editing. Re-run the same real pipeline shape
after the fix; delete temporary diagnostics.

Report exact evidence and any unavailable live surface. Gates are in
`cartethyia-engineering/references/verification.md`.
