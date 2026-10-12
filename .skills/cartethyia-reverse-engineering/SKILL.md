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

## Inspect a local VS Code integration

Use this procedure when Cartethyia needs to understand an installed VS Code
integration, such as Copilot Chat, to reproduce a compatible request flow. Keep
the work limited to an installation and account the user is authorized to
inspect. The goal is to document observable protocol behavior, not to copy
extension implementation or bypass product access controls.

1. **Pin the exact build.** Record the VS Code product version, extension
   identifier and version, platform, and install source. Inspect the installer
   or binary's Authenticode signature when provenance matters. Do not assume
   current online source describes the installed bundle.
2. **Locate the extension bundle.** Use VS Code's extension metadata and
   installation layout to identify the active Copilot extension files. Search
   only relevant bundles for known UI labels, endpoint fragments, dispatcher
   names, request headers, and model identifiers. Avoid broad collection of
   user profile data.
3. **Follow references, not just strings.** For each endpoint, trace the
   definition/getter to its caller, dispatcher branch, payload builder, header
   builder, and response handling. Record the method, path, required fields,
   relevant headers, and how the UI selection maps to the wire request.
   Minified bundles may require examining a narrow surrounding context; do not
   treat a lone string match as proof of a live call.
4. **Separate UI concepts from API contracts.** A picker item such as `auto`
   may be a synthetic routing mode rather than a model accepted by a normal
   inference endpoint. Verify which dispatcher path is called and what body is
   actually constructed before adapting Cartethyia.
5. **Triangulate versioned evidence.** Compare bundle behavior with official
   product documentation and public client implementations where available.
   Match their versions to the installed extension. A public source at a nearby
   version is corroboration, not proof of the installed version's contract.
6. **Probe only an authorized path.** Prefer the user's own running VS Code
   session or a local Cartethyia test boundary. If a direct request is
   explicitly authorized, use a disposable/rotatable credential, minimal
   non-sensitive prompt, bounded request count, and redacted output. Never put
   tokens in source, shell history, saved traces, or this skill. A rejection
   such as an API-version error means the request was not validated; do not
   guess repeatedly at versions or payloads.
7. **Close the evidence loop.** Mark every result as confirmed from the bundle,
   corroborated by docs/source, observed at runtime, or still unknown. Add
   regression tests at Cartethyia's adapter boundary using fake transport for
   headers and payload shape; use live checks only for what a mock cannot
   prove. Record unsuccessful probes and their exact limitation without
   presenting them as confirmed behavior.
8. **Implement only the compatibility delta.** Translate the verified behavior
   into Cartethyia's provider adapter and canonical flow. Keep provider-only
   headers out of shared auth/discovery constants, preserve existing security
   boundaries, and avoid copying proprietary source or unrelated client
   internals.

### Worked investigation: Copilot Auto routing

This investigation used the user's local VS Code 1.141.0 installation and
Copilot Chat 0.69.0. The executable was under
`%LOCALAPPDATA%\Programs\Microsoft VS Code\2a59476c9b\`; the active extension
bundle was `resources\app\extensions\copilot\dist\extension.js`. The installer
was also checked: its Authenticode signature was valid and signed by Microsoft.
Pinning these versions first mattered because public source and API versions
from another release did not necessarily describe this installed client.

The investigation proceeded from local evidence to the Cartethyia compatibility
question:

1. Read the installed VS Code product version and the Copilot extension's
   `package.json` version; verify installer provenance instead of assuming the
   executable or a downloaded installer matches the running build.
2. Search the installed extension bundle for endpoint fragments, UI model IDs,
   and dispatcher terms. A match only gave a lead. Follow the URL getter to the
   request dispatcher, then to the body/header builder and response path.
3. Trace the model picker selection into dispatch. The picker constructed a
   synthetic `auto` option, then the dispatcher routed it to a separate Auto
   path rather than sending `model: "auto"` to ordinary `/responses`.
4. Resolve the endpoint getters relative to the Copilot API base and record
   which dispatcher branch uses each path:

   - `/models` for the ordinary model catalog;
   - `/models/session` for Auto session models;
   - `/models/session/intent` for model routing/intent;
   - `/auto` for Auto inference.

5. Query the account-scoped `/models` catalog through the authorized integration
   and compare the returned IDs and endpoint declarations to Cartethyia's
   catalog/discovery behavior. The observed response contained 55 model entries,
   including `gpt-6-luna` and models declaring a Responses endpoint. Treat such
   a result as an account-and-time-specific catalog snapshot, not a global
   guarantee that every SKU is callable.
6. Test the specific compatibility hypothesis at the documented dispatch
   boundary, recording only the minimal request shape, status, and sanitized
   error. `gpt-6-luna` on `/responses` returned `400 model_not_supported`.
   Adding `contextTier: "long_context"` did not make it work: one authorized
   credential received `402 payment required`; a second received
   `400 model_not_supported`. Thus the catalog listing did not prove inference
   access, and context tier alone was not a fix.
7. Test the UI/API distinction: `model: "auto"` on ordinary `/responses` also
   returned `400 model_not_supported`. Combined with the bundle's separate
   `/auto` dispatcher branch, this confirmed that Auto was not a normal model
   ID for `/responses`.
8. For a direct `/auto` probe, start from the exact installed request builder
   and required headers—not a guessed Responses body. In this investigation,
   the body schema was not recovered before the probe. A guessed minimal body
   with `model: "auto"` was rejected with `invalid apiVersion` both with the
   Cartethyia-era `2026-06-01` header and with that header omitted. Those
   responses failed at API-version validation and therefore said nothing about
   whether the body schema or model selection would work.
9. Compare versioned corroboration. A public Copilot API client at version
   0.68.0 declared API version `2026-08-01`, while another public project used
   `2026-06-01`. `2026-08-01` was a lead to investigate, not proof of the
   required version for installed Copilot Chat 0.69.0; the direct probe was not
   completed successfully. Keep the version and payload contract marked
   **unknown** until verified against the installed build or a successful
   authorized request.
10. Turn only verified behavior into a Cartethyia delta. Keep inference-only
    headers out of shared OAuth, account-profile, and model-discovery headers.
    Add fake-transport adapter tests for exact outbound method/path, relevant
    headers, and payload; reserve live traffic for confirming the provider
    behavior that the fake cannot establish.

### Header and implementation comparison

The investigation also compared Cartethyia's GitHub adapter with the
separately checked-out `Public/copilot-api` source (commit `51d1307`, client
version 0.68.0). Keep this evidence distinct from the installed 0.69.0 bundle:

- The local Cartethyia owner for its static GitHub Copilot identity headers is
  `src/providers/integrations/github/github-oauth.ts`; those headers are shared
  by inference and non-inference calls such as OAuth/profile/catalog paths.
  Therefore request-specific inference headers must be added in the adapter's
  request-time header path, not to that shared constant.
- The comparison implementation adds request context such as
  `x-initiator: user|agent`, `copilot-vision-request` when images are present,
  `openai-intent`, `x-interaction-type`, `x-request-id`, and
  `x-agent-task-id`. These names are useful search targets and compatibility
  leads; verify each against the exact installed bundle and dispatcher before
  treating it as required for version 0.69.0.
- Desktop installation/device identity headers such as `editor-device-id`,
  `vscode-machineid`, `vscode-sessionid`, and
  `x-vscode-user-agent-library-version` are not automatically appropriate for
  a gateway. Do not copy them without evidence that the upstream requires them
  for this specific integration and that Cartethyia can supply them safely.
- The compared public source refreshes the model list periodically (about every
  30 minutes) and filters entries using its model-picker and policy fields.
  Cartethyia's discovery is account-scoped and consumes that account's
  `/models` result. Compare refresh lifecycle, filtering, and per-account
  behavior separately; a matching endpoint alone does not imply matching
  catalog semantics.
- Version headers are especially easy to overfit: the checked-out public
  client used `2026-08-01`, another public project used `2026-06-01`, and the
  Cartethyia integration used `2026-06-01` at the time. The direct `/auto`
  probes rejected both a `2026-06-01` request and a request without that header
  as `invalid apiVersion`; the public client's value was not proven against the
  installed 0.69.0 extension. Do not change a shared version header based only
  on this comparison.

The useful result was a compatibility map, not a claim that Cartethyia already
matched every VS Code request detail. For implementation, follow the
Cartethyia provider adapter's actual header/payload path and exercise it with a
fake fetch. A diff against another client's source identifies hypotheses; the
installed local bundle and a successful authorized request establish evidence.

### What "all the way" means

Before calling this investigation complete, keep an evidence ledger with these
columns: **question**, **evidence source/version**, **observed result**,
**confidence/status**, and **next proof needed**. For this case the ledger is:

| Question | Evidence | Status |
|---|---|---|
| Which local client was inspected? | VS Code 1.141.0, Copilot Chat 0.69.0; signed Microsoft installer | Confirmed locally |
| Is Auto an ordinary model ID? | Installed UI-to-dispatch flow plus `/responses` rejection | Separate `/auto` path confirmed |
| Which Auto endpoints exist? | URL getters followed to dispatcher branches in installed bundle | Confirmed endpoint map |
| Which models does this account's catalog list? | Authorized `/models` response | 55 entries observed at that time |
| Can this account call `gpt-6-luna`? | `/responses` attempts, including long-context variant | Not established; observed rejections |
| What is `/auto`'s exact API version and body schema? | Guessed probe rejected before inference validation | Unknown; do not claim compatibility |

The request and its failures were also cross-checked against Cartethyia's
GitHub provider implementation: catalog discovery, per-account model routing,
headers, canonical request translation, and endpoint selection are separate
owners. That prevents an upstream discovery result or a UI label from being
mistaken for Cartethyia's actual dispatched request.

**Credential hygiene:** credentials were used only for authorized inspection;
never copy them into this skill, a fixture, command history, or report. If a
credential was pasted into an unintended place, advise revoking/rotating it
and authenticate again. Do not reproduce its value.

## Safety and scope

- Inspect only code, tests, fixtures, logs, and local runtime behavior that the
  user is authorized to access.
- Never expose or persist credentials, tokens, personal data, or unredacted
  captured payloads.
- Do not infer exploitable vulnerabilities from this workflow; security
  assessments belong to the repository's security-review process.
- Do not edit generated output or unrelated code while tracing behavior.
