---
name: cartethyia-trace-replay
description: "Attribute a failing request to one field: replay it verbatim, bisect until it turns 200, fix the owning layer, prove the flip. Use for a Request Detail, error envelope, 4xx/5xx trace, or payload dump — plus remote debugging against a live gateway with the default API key."
---

# Trace replay and bisection

Use when a request failed and the cause is not yet pinned to a specific field.

Method: **reproduce the exact failure, then remove one thing at a time until it
turns 200.** The field whose removal flips the status is the cause. Do not stop
at a plausible-looking suspect — a parameter that "should" matter and one that
does are different things, and this method is cheap enough to settle it.

This method attributed a `400 model_param_invalid` on a 3.16M-char prompt to an
**absent** `max_tokens` — not to payload size and not to `reasoning_effort`,
both of which looked like better suspects.

## Steps

1. **Reproduce verbatim** — send the captured body unchanged. If it does not
   fail, you do not yet have the failure. Find out why before bisecting
   (different route, key, or deployment state).
2. **Run it three times.** One 400 may be transient; three identical failures is
   a deterministic reproduction you can bisect against. One variable per step.
3. **Bisect** on the full payload — strip optional controls one at a time
   (`prompt_cache_key`, `reasoning_effort`, `stream_options`, `thinking`,
   `reasoning_summary`), then shrink size, then **add** the field you suspect is
   missing.
4. **Attribute** the field to its owner in this repo (below), and fix there.
5. **Prove the flip** against a real instance, and prove the test locks it.

## Read the decisive test

Same failing body, only that field varies:

| Variation | Reading |
|---|---|
| No `max_tokens` fails, `max_tokens=1` passes | Upstream rejects the **absent** field, not its magnitude |
| Fails at every value | The field is wrong, not missing |
| Passes small, fails large | Size-bound — binary-search the threshold |

Binary-search rather than guessing: known-good low, known-bad high, halve until
they meet. A sharp threshold is a real bound; a fuzzy one usually means you are
not measuring the right variable.

Read the provider's own code, not the gateway's. `details.providerCode` carries
it (`model_param_invalid`, `11133`, `11148`); the public `message` is often
generic and names nothing.

**Guard against the size red herring.** A large failing payload makes you
suspect size. Before concluding that, add a tiny explicit limit: 3.16M chars +
`max_tokens=1` returning 200 proves size was never the bound. A field whose
*presence* fixes it is the cause, however large the payload.

## Where the owner usually is

| Suspect | Owner |
|---|---|
| Output-limit fields | `WIRE_TOKEN_BOUNDS` / `resolveWireMaxTokens` in `src/transport/translation/quirks.ts` |
| Chat body | `canonicalToChatPayload` in `src/protocol/request/chat.ts` |
| Responses body | `canonicalToResponsesPayload` in `src/protocol/request/responses.ts` |
| Provider-specific hooks | `buddyPrePayloadCommon` in `src/providers/integrations/buddy/buddy-chat-shared.ts`, and each adapter's `prePayload` |
| Error mapping/classification | `mapUpstreamHttpError` in `src/transport/failure-policy.ts` |

A call site that consults the bound table **only when the caller sent a value**
forwards an omitted field as absent. Look for `if (typeof x === "number")`
guards around a resolver that also owns a default: the default exists but is
unreachable. That is the shape of this bug class.

Fix the owner, not the adapter that reported it, so every upstream on that wire
gets the guard.

## Image generation replay

For `POST /v1/images/generations`, identify the listener before bisecting the
body. `Get-NetTCPConnection -LocalPort 12800` must show `bun run --hot
src/main.ts` after a source edit. `dist/cartethyia.exe` and a hot process
started before the edit can answer with the old payload. Do not assign `$pid`
in PowerShell; it is read-only.

Capture the body at the last boundary that still owns it. For Codex, compare
the object passed to `postUpstreamJson` with the string inside
`pinnedFetch`. If both contain `tools` and the upstream still says
`tool_choice` must be specified with `tools`, the body is not the cause.
Replay that same body directly to the provider before editing another choice
or header.

Do not treat a 200 chat response as an image. The proof is an
`image_generation_call` or `inlineData` whose decoded bytes start with
`89 50 4E 47` or `FF D8 FF`. The wire owners and the known account-boundary
errors are in `cartethyia-provider-catalog`.

## Wire bytes and payload capture

When the failure needs the actual bytes rather than a bisect, read
`references/payload-and-tracing.md` — frame layout, the four surfaces to
compare, SSE replay, and what must never be logged.

## Remote debugging

The gateway accepts the default API key from the environment
(`CARTETHYIA_API_KEY`), which is all-allowed, so a live remote instance can be
probed directly. Read the key and origin **from the environment** — never from a
message, never echoed into output.

```bash
BASE="https://<host>/v1"
curl -s "$BASE/models" -H "authorization: Bearer $KEY" -H "user-agent: <client ua>"
```

Two things block a remote probe before any application code sees it:

- **Cloudflare 1010** ("error code: 1010") — browser integrity check. Send a
  real `user-agent` matching the failing client and `accept: application/json`.
  A bare script gets 1010 and it looks like an outage.
- **401 from an edge proxy** (openresty/APISIX) — a captured session credential
  expired. This is NOT a parameter problem. Conclude nothing about parameters
  from it; switch to the live gateway with a current key.

## Prove the flip

Unit tests and typecheck do not prove a wire change. Replay the original failing
body against an instance carrying the change and show the status change.

```bash
PORT=12801 CARTETHYIA_PUBLIC_ORIGIN=http://127.0.0.1:12801 bun run src/main.ts
```

Confirm the route exists first — a local deployment lacks a remote
deployment's aliases, and a 404 there is a fixture gap, not a result:

```bash
curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:12801/v1/models
```

**Prove the new test locks the fix:** revert the change, see the test fail,
restore it, see it pass. A test that passes both ways proves nothing.

## Hygiene

- Credentials come from the environment. Never print, log, or write them to a
  file, and never paste them into a message or a commit.
- Work in a scratch directory outside the repo; delete it when done. Leave no
  replay scripts or captured payloads in the tree.
- Send the same `user-agent` as the failing client so the gateway takes the same
  path.
- Stop any instance you started.
- Repeated failures trip the IP strike counter ("Warning n/10 … will
  temporarily ban this IP"). Keep probe counts low and list `/v1/models` before
  guessing model ids.

## Report

State the exact field that caused it, the replay table (what passed, what
failed), whether the failure was deterministic, the layer you fixed and why it
owns it, and the before/after status against a real instance. Say plainly what
you could not verify — e.g. whether other upstreams on that wire share the
behavior, when the available routes could not exercise them.
