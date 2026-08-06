# Cartethyia Engineering Guide

This file is the repository convention for maintainers and coding agents. Keep changes aligned with the active runtime under `src/`; `src.old/` is read-only migration reference code and must never be imported by production code.

## Project intent

Cartethyia is a self-hosted Bun + Elysia AI proxy with:

- OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and image-generation routes.
- Cross-protocol request/response translation through one canonical internal contract.
- Provider accounts, credentials, OAuth, aliases, combos, routing, failover, limits, telemetry, and an authenticated dashboard.

The runtime is an HTTP proxy and control plane, not a provider SDK and not an upstream client identity.

## Architectural boundaries

Keep dependencies flowing inward toward domain contracts and outward toward infrastructure:

```text
src/main.ts
  -> src/app/
  -> src/domain/
  -> src/providers/ + src/transport/
  -> src/storage/ + network
```

### Domain

`src/domain/` owns provider-neutral contracts and protocol behavior:

- `src/domain/contracts.ts`: canonical request, response, stream, provider, routing, model metadata, and error contracts.
- `src/domain/protocols/`: client normalization, wire payload codecs, usage conversion, response translation, and protocol-level errors.
- `src/domain/routing.ts`: route and model policy that is independent of a concrete HTTP client.
- `src/domain/model-metadata.ts`: canonical context, capability, pricing, and source resolution for direct models, router aliases, and combos.

Protocol modules may know OpenAI, Anthropic, or Gemini wire shapes. They must not know API keys, provider account storage, HTTP clients, base URLs, or provider-specific OAuth.

### Model catalog

- `GET /v1/models` lists direct models, router aliases, and combos permitted by the authenticated API key. Each entry keeps the client-facing identifier in `id`.
- Router aliases use `metadata.kind: "router"` and inherit context limits, capability categories, pricing, source, and update timestamp from their resolved targets. Unknown metadata stays `null`; never fabricate limits or prices.
- The public listing must not replace a router alias ID with its resolved target. Dispatch still resolves the alias through the normal routing chain.

### Application

`src/app/` owns orchestration:

- request normalization and dispatch
- route/account/model selection
- capability checks
- retries, failover, cooldowns, and recovery
- scheduled account recovery sweep (`AccountRecoverySweep`) that transitions expired cooldowns to healthy and clears expired per-model locks
- authorization limits and telemetry handles
- response presentation for the requested client surface

Do not put provider HTTP calls or database queries in application route handlers.

### Providers

`src/providers/` owns provider integration:

- provider ID and display metadata
- credential kind and account policy
- base URL and endpoint policy
- model catalog
- capability declaration
- provider-specific headers, authentication, and request policy
- target validation

A provider adapter must not reimplement shared OpenAI, Responses, Anthropic, Gemini, or cross-protocol codecs. Reuse `src/domain/protocols/` and `src/transport/protocols/`.

### Transport

`src/transport/` owns upstream execution:

- HTTP request execution
- abort and timeout coordination
- bounded response reads (JSON body reads capped at 1 MiB; error bodies capped at 16 KiB)
- SSE/NDJSON framing
- upstream protocol stream mappers
- upstream error extraction

Transport modules may depend on provider shared network helpers. They must not select accounts, mutate routing state, or access console repositories.

### Storage and console

- `src/storage/main/` owns configuration SQLite state.
- `src/storage/runtime/` owns runtime telemetry SQLite state.
- Keep configuration and high-frequency telemetry databases separate.
- `src/console/` owns authenticated control-plane APIs and services.
- `dashboard/src/` owns dashboard UI and client-side state.

Routes should call repositories/services through their existing boundaries instead of issuing ad-hoc SQL.

## Protocol rules

1. Normalize every supported client surface into `NormalizedProviderRequest`.
2. Route using capabilities and `wireSurfaceFor`; do not compare provider names to decide protocol compatibility.
3. Preserve the requested client surface on the way back to the caller.
4. Non-streaming responses must be translated through the shared protocol boundary.
5. Streaming responses must use canonical `StreamEvent` values and the requested surface encoder.
6. Preserve text, reasoning, tool calls, usage, stop reasons, and refusal/error information where the target surface supports them.
7. Protocol conversion errors use `ProtocolCodecError`; provider/transport failures use the provider call error contract.
8. Do not add a new provider-specific copy of an existing protocol codec.
9. Provider adapters that proxy as a specific upstream client identity (e.g. `claude-code`, `grok-build`, `kiro`, `qoder`) emit that client's canonical `User-Agent` fingerprint so the upstream sees a legitimate session. Forward the client's own `User-Agent` when it matches the expected identity prefix; otherwise emit the adapter's canonical fingerprint. Do not invent a `Cartethyia` identity or forward arbitrary client headers unless the adapter explicitly permits it.
10. Provider IDs are routing identifiers. Renaming one requires a migration note, changelog entry, and updates to aliases, combos, ACLs, tests, and dashboard references.

## Provider rules

- Official SDK packages are not required for runtime dispatch. Use the documented upstream HTTP contract through the adapter and transport layers.
- A provider adapter must declare its real `protocol`, `credentialKind`, surfaces, streaming support, images/tool/reasoning capabilities, and model catalog.
- Compatible providers should reuse the OpenAI, Responses, or Anthropic protocol modules without importing another provider adapter.
- Credentials are acquired through the existing account/lease boundary. Do not read provider secrets directly from route handlers.
- Upstream URLs must pass the existing SSRF and redirect policy. Do not weaken URL validation for a provider shortcut.
- Upstream errors must be bounded, typed, sanitized, and mapped to the shared error envelope.
- Add a deterministic adapter test for each new provider or protocol behavior.

## TypeScript and Bun conventions

- Use strict TypeScript and preserve `noUncheckedIndexedAccess`, `noImplicitOverride`, and `verbatimModuleSyntax`.
- Prefer `unknown` plus narrowing for external data. Avoid `any` in production code.
- Use `import type` for type-only imports.
- Use explicit exported function/class return types when the boundary is non-trivial.
- Keep modules focused; split protocol, provider, transport, storage, and UI concerns instead of creating broad utility modules.
- Prefer pure functions for normalization and conversion. Keep network and persistence side effects at the boundary.
- Throw `Error` subclasses or typed contract errors, never strings or raw provider bodies.
- Do not suppress errors with empty catches, `@ts-ignore`, or placeholder fallbacks.
- Do not leave TODO-only implementations, fake adapters, no-op paths, or misleading stubs.
- Use Bun commands and existing package scripts; do not add a dependency when the current runtime already provides the needed capability.

## Security rules

- Treat all request bodies, headers, provider responses, OAuth responses, and custom-provider configuration as untrusted input.
- Keep bounded body, stream, timeout, redirect, SSRF, and concurrency protections intact.
- Never log credentials, bearer tokens, API keys, raw authorization headers, or unredacted upstream bodies.
- Console list/detail endpoints must mask secrets (API keys, Warp credentials) in a view model. Return raw secrets only through an explicit credential endpoint.
- db-map sensitive column masking must cover all secret columns in both config and runtime databases.
- Keep error messages sanitized at public API and console boundaries.
- Do not persist request/response bodies in runtime telemetry unless an explicitly documented storage mode requires it.
- Do not bypass API-key ACL, account lease, proxy-pool, or per-IP admission checks.

## Dashboard rules

- Reuse existing UI primitives, design tokens, motion settings, and responsive patterns.
- Keep desktop and mobile layouts equivalent in capability.
- Respect reduced-motion settings and avoid unnecessary per-row animation work.
- Keep dialogs mounted until exit animations finish.
- Prefer existing API hooks and query invalidation patterns over bespoke fetch state.
- When changing an API contract, update the dashboard caller, loading state, error state, and tests together.

## Testing and verification

For backend changes:

```bash
bunx tsc --noEmit -p .
bun test --timeout 60000 test/
```

For dashboard changes:

```bash
cd dashboard
bun run build
bun run test
```

Targeted tests should cover the observable contract being changed. Add tests for protocol boundaries, routing precedence, stream terminals, tool/reasoning preservation, auth failures, migration-sensitive provider IDs, and `/v1/models` router metadata inheritance when applicable.

Do not claim a behavioral change is complete from a typecheck alone. Run the narrowest relevant scenario and then the relevant suite.

## Documentation and releases

- Keep `README.md` short: purpose, quick start, API routes, configuration pointer, development commands, and links to release docs.
- Put detailed architecture, migration, breaking-change, added, and removed notes in `CHANGELOG.md` or `docs/`.
- Every public provider ID rename, route change, persistence change, removed setting, or compatibility change needs a changelog entry.
- When comparing releases, identify the baseline commit/version and distinguish a release summary from the raw Git patch.
- Update README and changelog claims only from verified source or test output.

## Change workflow

1. Inspect the existing boundary and callers before editing.
2. Reuse the existing module and naming convention; do not create a parallel abstraction.
3. Update exported symbol callers and tests in the same change.
4. Keep migrations explicit for IDs, persistence, environment variables, and routes.
5. Run targeted verification, then the applicable full suite.
6. Review the final diff for stale imports, dead exports, compatibility aliases, secrets, and broken documentation links.

Prefer a complete, boring change over a clever abstraction. The active runtime must remain understandable to the next maintainer without consulting `src.old/`.
