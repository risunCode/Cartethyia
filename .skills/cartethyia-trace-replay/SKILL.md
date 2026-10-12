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
2. **Repeat the baseline.** A single 400 may be transient; replay it several
   times (three is a useful starting point) and confirm the same failure before
   bisecting. Repeated failures establish a reproducible baseline, not proof
   that every run will fail. Change one variable per step.
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

Read the provider's own response/code, not just the gateway's. When retained,
`details.providerCode` may carry it (`model_param_invalid`, `11133`, `11148`);
the public `message` is often generic and names nothing.

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
body. `Get-NetTCPConnection -LocalPort 12800 -State Listen` reports the
listening process id, not its command line; inspect its `OwningProcess` (for
example, through `Get-CimInstance Win32_Process`) to confirm the listener is
`bun run --hot src/main.ts`. `dist/cartethyia.exe` or a process that still has a
cached adapter can answer with the old payload. Do not assign `$pid` in
PowerShell; it is read-only.

Capture the body at the last boundary that still owns it. For Codex, compare
the object passed to `postUpstreamJson` with the string inside
`pinnedFetch`. If both contain `tools` and the upstream still says
`tool_choice` must be specified with `tools`, the body is not the cause.
Replay that same body directly to the provider only when the probe is
authorized; otherwise retain the evidence and do not edit another choice or
header based on an unverified direct replay.

Do not treat a 200 chat response as an image. The proof is an
`image_generation_call` or `inlineData` whose decoded bytes start with
`89 50 4E 47` or `FF D8 FF`. The wire owners and the known account-boundary
errors are in the
[provider-catalog skill](../cartethyia-provider-catalog/SKILL.md).

For Grok video, a 403 or a chat-only 200 from `cli-chat-proxy.grok.com` is not
necessarily a payload bug. The notes in the
[provider-catalog skill](../cartethyia-provider-catalog/SKILL.md) describe
direct xAI console probes, not a Cartethyia video adapter. The checked-in Grok
integration and provider image-generation tests do not implement or verify
that console flow. Re-check the endpoint, authentication, and limits with an
authorized direct probe before relying on those field notes or changing a
gateway adapter.

## Wire bytes and payload capture

When the failure needs the actual bytes rather than a bisect, read
`references/payload-and-tracing.md` — frame layout, the four surfaces to
compare, SSE replay, and what must never be logged.

## Remote debugging

The first-boot setup seeds a default tenant API key from
`CARTETHYIA_API_KEY` (or generates one if it is unset); requests authenticate
against the active persisted key, not an implicit environment fallback. That
key receives `TENANT_KEY_SCOPES` (`src/security/access-control.ts`), not
`platform:admin`. Probe only an instance and key you are authorized to use.
Prefer credentials already made available for that instance; a key handed to
you in a message is usable only when authorized, and handling either follows
`AGENTS.md` "Safety and git" — it never goes into a file, a commit, or output.
The examples below assume the environment variable still matches the active
persisted key; if setup generated a key or it has since changed, use the
authorized active key supplied through your approved secret-handling channel.

```bash
BASE="https://<host>/v1"
curl -s "$BASE/models" \
  -H "Authorization: Bearer ${CARTETHYIA_API_KEY}" \
  -H "user-agent: <client ua>"
```

Two things can block a remote probe before any application code sees it:

- **Cloudflare 1010** ("error code: 1010") — an edge rejection, not an
  application response. Matching the failing client's `user-agent` and
  `accept: application/json` can make a probe comparable, but does not
  guarantee access or bypass a browser-integrity challenge. Use an authorized
  client/environment rather than attempting to circumvent the edge.
- **401 from an edge proxy** (for example, openresty/APISIX) — the request was
  rejected before the gateway; it does not establish whether the credential,
  edge policy, or session is responsible. It is not evidence about a payload
  parameter. Resolve edge authentication with the instance owner before
  drawing conclusions about application behavior.

## Prove the flip

Unit tests and typecheck do not prove a wire change. Replay the original failing
body against an instance carrying the change and show the status change.

```bash
PORT=12801 CARTETHYIA_PUBLIC_ORIGIN=http://127.0.0.1:12801 bun run src/main.ts
```

PowerShell equivalent:

```powershell
$env:PORT = "12801"
$env:CARTETHYIA_PUBLIC_ORIGIN = "http://127.0.0.1:12801"
bun run src/main.ts
```

Confirm the route exists first — a local deployment lacks a remote
deployment's aliases, and a 404 there is a fixture gap, not a result:

```bash
curl -s -H "Authorization: Bearer ${CARTETHYIA_API_KEY}" \
  http://127.0.0.1:12801/v1/models
```

PowerShell equivalent:

```powershell
curl.exe -s -H "Authorization: Bearer $env:CARTETHYIA_API_KEY" `
  http://127.0.0.1:12801/v1/models
```

**Prove the new test locks the fix:** revert the change, see the test fail,
restore it, see it pass. A test that passes both ways proves nothing.

## Hygiene

- Never print, log, or write a credential to a file, and never put one in a
  commit. A credential given in a message is fine; `AGENTS.md` "Safety and git"
  is the owner of the rest.
- Work in a scratch directory outside the repo; delete it when done. Leave no
  replay scripts or captured payloads in the tree.
- Send the same `user-agent` as the failing client so the gateway takes the same
  path.
- Stop any instance you started.
- Repeated invalid model requests trip the IP strike window ("Warning n/10 … will temporarily ban this IP"). Keep probe counts low and list `/v1/models` before guessing model ids.

## Report

State the exact field that caused it, the replay table (what passed, what
failed), whether the baseline was repeatable, the layer you fixed and why it
owns it, and the before/after status against a real instance. Say plainly what
you could not verify — e.g. whether other upstreams on that wire share the
behavior, when the available routes could not exercise them.
