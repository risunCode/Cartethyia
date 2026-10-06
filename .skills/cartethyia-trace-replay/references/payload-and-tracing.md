# Payload and tracing

Use when a request failed or behaved oddly and the actual wire bytes are needed.
Payload retention is short; locate the frame quickly and never expose secrets.

## Locate and decode

Telemetry identifies the request. Payload metadata points to an append-only file
under `data/telemetry-payloads/`. A frame is:

```text
[4-byte big-endian length][JSON envelope]
```

The stored length includes the 4-byte header. Read the referenced slice, parse the
envelope, then inspect `.payload`; do not parse the whole file as one JSON value.
Oversized payloads may only retain a truncation marker.

## Compare the four surfaces

- `request_body`: client input
- `provider_request_body`: translated upstream request
- `provider_response_body`: raw upstream response
- `client_response_body` or `response_body`: gateway output

Upstream correct + client wrong points to parsing/encoding. Upstream wrong points
to request translation, routing, or provider preparation. Missing payload is not
proof that the field was absent.

## Streaming replay

Preserve `data:` frames and blank-line boundaries when replaying an SSE response.
Feed the real surface decoder and inspect canonical events, terminal outcome, usage,
reasoning, and tool calls.

## Failure trace

1. Start with telemetry status, category, origin, TTFB, and latency.
2. Identify the abort/deadline source from current config and signal reason.
3. Follow the request through attempt loop and stream cleanup.
4. Compare raw and translated surfaces before editing code.
5. Fix the layer that lost the information; reproduce the same shape afterward.

Do not call a cancelled request an upstream failure merely because a signal was
aborted; classify the error and abort reason together.

## Safety

Use `bun -e` or a throwaway script for local payload inspection when required.
Do not log credentials, authorization headers, raw secrets, or full sensitive bodies.
Delete temporary scripts and never add `data/` to git.
