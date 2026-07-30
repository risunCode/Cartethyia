# Changelog

All notable changes to Cartethyia are documented here.

## [Unreleased]

## [1.0.1-alpha] - 2026-07-30

### Changed

- Provider credentials are stored as plaintext in `provider_accounts.credential` and `custom_providers.credential`; only the console login password remains hashed. Credential-at-rest encryption, the `CREDENTIAL_ENCRYPTION_KEY`/`CREDENTIAL_ENCRYPTION_KEY_FILE` settings, the on-disk credential key file, and the "Rotate credential key" console action are removed.
- Proxy API keys are now stored as plaintext in `api_keys.key`. The full key can be retrieved via `GET /console/api/keys/:id/credential` and copied from the dashboard.
- Removed the `OPENCODE_FREE_ACCESS` env setting and the `opencodeFreeAccess` runtime setting entirely. OpenCode Free models are always accessible to any request with a valid Cartethyia API key, exactly like every other provider namespace.
- Internal cleanup pass (no behavior change): consolidated duplicated numeric validation, text flattening, model-id extraction, date/period arithmetic, console SSE streaming, closed-set type guards, and upstream provider HTTP-error/finish-reason mapping into shared modules (`src/utils/`, `src/shared/`, `src/console/sse.ts`, `providers/index.ts`'s `classifyUpstreamStatus`/`providerHttpError`). See `.kiro/specs/codebase-merge-optimization/` for the full audit and rationale, including proposals intentionally rejected (dynamic error-class migration, generic delete-record helper).

### Fixed

- Hardened every user-configured upstream and proxy URL against private IPv4/IPv6 targets, DNS rebinding, and unsafe redirect chains. Custom-provider dispatch now validates resolved targets immediately before network I/O.
- Stored provider-account authentication failures now fail over to the next eligible account; repeated account/model failures are isolated with per-model locks instead of taking down the entire account.
- Interrupted streaming responses now emit protocol-correct terminal error events, terminal sentinels, and cancel their upstream reader when the client disconnects.

- Testing a provider connection no longer fails with a generic 500 "Something unexpected interrupted this request" error. Credential reads previously threw an unguarded decryption error whenever the stored key no longer matched the running server's key (for example after a redeploy that reset the key file), which broke both the console's Test action and live account-rotated proxy traffic.

### Added

- ACL-aware `GET /v1/models`: when `PROXY_AUTH_MODE=api_key`, a valid proxy key is required; the response includes only models permitted by that key's provider/model allowlists and denylist (aliases and combos included). In open mode the catalog is public, but an optional key still filters the list.
- Extended proxy API key limits and ACL: monthly token cap, max concurrent in-flight requests, model denylist, and `PATCH /console/api/keys/:id` for editing limits after creation.
- Overview dashboard **Edit** action for API keys (limits, provider allowlist, model allow/deny lists).

- `GET /v1/models` now advertises all locally routeable built-in provider models, custom-provider models, aliases, and combos using the same IDs accepted by dispatch.
- Versioned SQLite migrations, persisted account cooldown/model-lock state, periodic WAL checkpoints, and graceful DB shutdown.
- Opt-in `CORS_ALLOWED_ORIGINS` support for public `/v1/*` APIs only.
- Bulk provider-account import from pasted exports, with worker parsing, duplicate-name handling, line-level reporting, and an Import dialog in provider detail.
- Cursor-paginated provider connections with incremental/windowed dashboard rendering for large account collections.
- Bounded runtime rate-limit and request-detail tracking, scheduled memory cleanup, and a documented local memory smoke test.

- Copy action on each provider connection, backed by `GET /console/api/providers/:id/accounts/:accountId/credential`. The secret is fetched only when the operator clicks copy (never in the polled accounts list) and the read is audited.

### Removed

- `POST /console/api/settings/rotate-credential-key` and the credential-key rotation UI.
- The settings Danger Zone section, its "Rotate JWT secret" button, and the "Log out all sessions" button. The `/console/api/settings/rotate-jwt-secret` and `/console/api/settings/logout-all` endpoints remain available.

### Migration

- The `credential_enc` columns are renamed to `credential`. Existing databases carry unreadable ciphertext under the old key, so reset the database (delete `DATA_DIR/cartethyia.sqlite*` and `DATA_DIR/.credential-key`) and re-add provider connections.
- Migration v7 adds `monthly_token_limit`, `max_concurrent_requests`, and `model_denylist` to `api_keys`. Existing databases upgrade automatically on startup.

### Verification

- Backend test suite: 464 tests passing, 1 skipped.
- Dashboard TypeScript typecheck and production build passing.

## [1.0.0-alpha] - 2026-07-30

This is the first release-line marker for the feature-complete alpha. It is intended for local and self-hosted testing while upstream provider behavior and operational hardening continue to mature.

### Added

- Authenticated React/Vite management console with responsive desktop and mobile layouts.
- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatibility routes.
- Built-in provider catalog with OAuth, API-key, free-tier, and compatible-provider integrations.
- Console-managed custom OpenAI-compatible and Anthropic-compatible providers.
- Custom provider headers, model metadata enrichment, per-model testing, and direct `<slug>/<model>` model qualification.
- Aliases, combos, filter rules, account routing, failover, cooldowns, priority routing, and round-robin routing.
- Runtime usage, estimated cost, in-flight request, per-IP active-flight, health, CPU, and memory metrics.
- Cross-platform RAM clearing through Bun garbage collection.
- Provider credential storage, API-key access control, console JWT sessions, and schema migration support.
- Responsive themed dropdowns and compact mobile app-bar navigation.
- Route-chunk prefetching and direct route rendering to keep console navigation responsive.

### Changed

- Provider ordering is curated manually instead of alphabetically.
- Custom provider model IDs no longer use a public `custom/` wrapper.
- Health metrics distinguish whole-machine RAM from Cartethyia process RSS and display explicit MB/GB units.
- Unicode punctuation in user-facing dashboard text is rendered as actual punctuation instead of literal `\\uXXXX` sequences.
- Global error logging now records the underlying server error for unhandled 500 responses.

### Verification

- Backend test suite: 417 tests passing.
- Dashboard TypeScript typecheck and production build passing.
- Browser smoke tests cover provider management, custom provider routing, health metrics, themed dropdowns, mobile layout, and repeated console navigation.

### Alpha caveats

- Provider availability, quotas, authentication flows, and model catalogs remain dependent on upstream services.
- Upstream provider-specific regressions may require adapter updates as their APIs change.
