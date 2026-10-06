---
name: cartethyia-trace-replay
description: "Replay a captured failing request and bisect it until it passes, to find which field actually causes an upstream 4xx/5xx. Use for a Request Detail / error report / trace dump you need to attribute to a specific parameter, plus remote debugging against a live gateway with the default API key."
---

# Trace replay and bisection

Use when you have a failing request — a Request Detail panel, an error envelope,
or a captured request file — and the cause is not yet attributed to a specific
field.

The method: **reproduce the exact failure, then remove one thing at a time until
it turns 200.** The field whose removal flips the status is the cause. Do not
stop at a plausible-looking suspect; a parameter that "should" matter and one
that does are different things, and this method is cheap enough to settle it.

This is the method that found `400 model_param_invalid` on a 3.16M-char prompt
to WorkBuddy: the cause was an **absent** `max_tokens`, not the payload size and
not `reasoning_effort`, both of which looked like better suspects.

## Remote debugging

The gateway accepts the default API key from the environment
(`CARTETHYIA_API_KEY`), which is all-allowed, so a live remote instance can be
probed directly. Read the key and the origin from the environment — never
from a message, never echoed into output.

```bash
BASE="https://<host>/v1"
curl -s "$BASE/models" -H "authorization: Bearer $KEY" -H "user-agent: <client ua>"
```

Two things will block a remote probe before any application code sees it:

- **Cloudflare 1010** ("error code: 1010") — browser integrity check. Send a
  real `user-agent` matching the failing client, and `accept: application/json`.
  A bare script gets 1010 and it looks like an outage.
- **401 from an edge proxy** (openresty/APISIX) — a captured session credential
  has expired. This is NOT a parameter problem. Do not conclude anything about
  parameters from it; switch to the live gateway with a current key.

## Reproduce before bisecting

1. **Replay verbatim first.** Send the captured body unchanged. If it does not
   fail, you do not yet have the failure — find out why before bisecting
   (different route, different key, different deployment state).
2. **Run the failing case three times.** A one-shot 400 may be transient; three
   consecutive identical failures is a deterministic reproduction you can bisect
   against.
3. **Keep one variable per step**, and change nothing else.

## Bisect

Strip optional controls one at a time on the **full** payload:

```
prompt_cache_key, reasoning_effort, stream_options, thinking, reasoning_summary
```

Then shrink payload size. Then, decisively: **add** the field you suspect is
missing.

The decisive test for an absent-vs-wrong parameter — same failing body, only
that field varies:

| Variation | Reading |
|---|---|
| Fails with no `max_tokens`, passes with `max_tokens=1` | Upstream rejects the **absent field**, not its magnitude |
| Fails at every value of the field | The field is wrong, not missing |
| Passes when payload shrinks, fails when it grows | Size-bound; then binary-search the threshold |

**Binary-search the threshold** rather than guessing: known-good low, known-bad
high, halve until they meet. A sharp threshold (2.27M chars OK, 2.28M 400) is a
real bound and worth reporting; a fuzzy one usually means you are not measuring
the right variable.

Read the provider's own code, not the gateway's. `details.providerCode` carries
it (`model_param_invalid`, `11133`, `11148`); the public `message` is often
generic ("Invalid request parameters") and names nothing.

## Guard against the size red herring

A large payload that fails will make you suspect size. Before concluding that,
add a tiny explicit limit: payload 3.16M chars + `max_tokens=1` returning 200
proves size was never the bound. **A field whose presence fixes it is the cause,
regardless of how large the payload is.**

## Attribute to the right layer

Once the field is known, find its owner in this repo and ask why it reached the
wire in that shape:

- Per-wire output limits: `WIRE_TOKEN_BOUNDS` and `resolveWireMaxTokens` in
  `src/transport/translation/quirks.ts`.
- Chat encoding: `canonicalToChatPayload` (`src/protocol/request/chat.ts`).
- Responses encoding: `canonicalToResponsesPayload`
  (`src/protocol/request/responses.ts`).
- Provider-specific payload hooks: `buddyPrePayloadCommon`
  (`src/providers/integrations/buddy/buddy-chat-shared.ts`), and each adapter's
  `prePayload`.
- Upstream error mapping: `mapUpstreamHttpError`
  (`src/transport/failure-policy.ts`).

A call site that only consults the bound table when the caller sent a value will
forward an omitted field as **absent** — check for `if (typeof x === "number")`
guards around a resolver that also owns a default. That is the shape of this
class of bug: the default exists but is unreachable.

Fix the owner, not the adapter that reported it, so every upstream on that wire
gets the guard.

## Prove the fix at the real boundary

Unit tests and typecheck do not prove a wire change. Replay the original failing
body against an instance carrying the change and show the status flipping.

```bash
PORT=12801 CARTETHYIA_PUBLIC_ORIGIN=http://127.0.0.1:12801 bun run src/main.ts
```

Confirm the route exists first — a local deployment will not have a remote
deployment's aliases, and a 404 there is a fixture gap, not a result:

```bash
curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:12801/v1/models
```

**Prove the new test locks the fix:** revert the change, see the test fail,
restore it, see it pass. A test that passes both ways proves nothing.

## Hygiene

- Credentials come from the environment. Never print, log, or write them to a
  file; never paste them into a message or a commit.
- Work in a scratch directory outside the repo; delete it when done. Do not
  leave replay scripts or captured payloads in the tree.
- Send the same `user-agent` as the failing client so the gateway takes the same
  path.
- Stop any instance you started.
- Expect repeated failures to trip the IP strike counter
  ("Warning n/10 … will temporarily ban this IP"). Keep probe counts low, and
  list `/v1/models` before guessing model ids.

## Report

State: the exact field that caused it, the replay table (what passed, what
failed), whether the failure was deterministic, the layer you fixed and why it
was the owner, and the before/after status against a real instance. Say plainly
what you could not verify — e.g. whether other upstreams on the same wire share
the behavior, when the available routes could not exercise them.
