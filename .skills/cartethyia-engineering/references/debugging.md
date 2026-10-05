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

## Database reset

Never reset production data. Verify the target environment first; use the
isolated `.env.test` database (`bun run test-db:up/check/down`) and a
transaction/backup when a reset is genuinely required.

## Verification

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when entry/contract changes
```

Report exact evidence and any unavailable live surface.
