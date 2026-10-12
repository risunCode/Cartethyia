---
name: cartethyia-reverse-engineering
description: "Use when reverse-engineering behavior within the Cartethyia codebase: trace an undocumented feature, reconstruct a request/data flow, map ownership across layers, or explain existing behavior before changing it."
---

# Reverse-engineer Cartethyia behavior

Use this skill to understand behavior implemented by this repository. This is
codebase-level reverse engineering: reconstruct Cartethyia's own request,
state, routing, persistence, provider, or dashboard behavior from its source
and tests. It is not a generic workflow for investigating unrelated software
or external systems.

## When to use

- The user asks how an undocumented Cartethyia feature or behavior works.
- A symptom crosses layers and its canonical owner is unclear.
- Existing behavior needs to be reconstructed before a fix, migration, or
  compatibility change.
- The user asks to "reverse" or map a Cartethyia flow from observed behavior.

For a reproducible failing request, wire payload, provider response, or live
dispatch, continue with
[`cartethyia-trace-replay`](../cartethyia-trace-replay/SKILL.md). For a focused
domain change, use the closest skill listed in `AGENTS.md`.

## Procedure

1. **Bound the question.** State the observed behavior and the exact question
   to answer. Choose the smallest relevant boundary: public endpoint, console
   action, provider capability, state transition, or stored record.
2. **Find the canonical owner.** Read `AGENTS.md` and identify the production
   owner and its tests. Prefer code intelligence or targeted symbol/search
   queries over broad repository-wide scans.
3. **Trace both directions.** Follow inputs through validation and parsing,
   canonical representation, policy/routing, provider or persistence effects,
   and output encoding/UI. For stateful behavior, include the writer, reader,
   lifecycle, and reset/migration path. Follow actual call sites and dispatch
   boundaries rather than assuming similarly named modules are connected.
4. **Separate evidence from inference.** Support each important step with the
   owning symbol, test, or observed output. Label unverified assumptions and
   conflicting/stale comments; do not promote a plausible explanation to fact.
5. **Check invariants and alternatives.** Look for capability gates,
   provider-specific behavior, degradation/failover, retries, cache keys,
   time-dependent inputs, normalization, and error paths that could change the
   outcome. Search consumers before recommending a change to a shared contract.
6. **Reproduce only when useful.** Prefer focused tests and fake transports.
   Use the isolated test database for persistence behavior. Live gateway
   verification must use the authorized local setup and redact credentials,
   session identifiers, and sensitive payloads. Do not probe external
   providers directly unless the user explicitly authorizes a safe probe.
7. **Report a compact behavior map.** Give the observed flow in order, cite
   relevant files/symbols, state what is proven versus unknown, and name the
   smallest next step. If implementation is requested, make the focused change
   and verify its acceptance criterion instead of stopping at analysis.

## Cartethyia flow landmarks

- Gateway surfaces parse OpenAI Chat, Responses, Anthropic Messages, and other
  supported inputs into the canonical request model.
- Routing and admission decide whether a model/account/capability can serve
  that request; retries and degradation are policy-controlled.
- Provider adapters own provider-specific auth, headers, endpoint selection,
  wire translation, and stream decoding.
- Canonical usage and events feed response encoding, telemetry, and the
  dashboard.
- Console API and dashboard behavior has separate owners; keep the browser
  dashboard free of backend-only modules and secrets.

Treat this list as navigation, not a substitute for checking current code.
Locate the current implementation and tests before drawing conclusions.

## Safety and scope

- Inspect only code, tests, fixtures, logs, and local runtime behavior that the
  user is authorized to access.
- Never expose or persist credentials, tokens, personal data, or unredacted
  captured payloads.
- Do not infer exploitable vulnerabilities from this workflow; security
  assessments belong to the repository's security-review process.
- Do not edit generated output or unrelated code while tracing behavior.
