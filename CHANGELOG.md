# Changelog

All notable changes to Cartethyia are documented here.

## [Unreleased]

### Changed

- Provider credentials are stored as plaintext in `provider_accounts.credential` and `custom_providers.credential`; only the console login password remains hashed. Credential-at-rest encryption, the `CREDENTIAL_ENCRYPTION_KEY`/`CREDENTIAL_ENCRYPTION_KEY_FILE` settings, the on-disk credential key file, and the "Rotate credential key" console action are removed.
- Proxy API keys are now stored as plaintext in `api_keys.key`. The full key can be retrieved via `GET /console/api/keys/:id/credential` and copied from the dashboard.
- Removed the `OPENCODE_FREE_ACCESS` env setting and the `opencodeFreeAccess` runtime setting entirely. OpenCode Free models are always accessible to any request with a valid Cartethyia API key, exactly like every other provider namespace.
- Internal cleanup pass (no behavior change): consolidated duplicated numeric validation, text flattening, model-id extraction, date/period arithmetic, console SSE streaming, closed-set type guards, and upstream provider HTTP-error/finish-reason mapping into shared modules (`src/utils/`, `src/shared/`, `src/console/sse.ts`, `providers/index.ts`'s `classifyUpstreamStatus`/`providerHttpError`). See `.kiro/specs/codebase-merge-optimization/` for the full audit and rationale, including proposals intentionally rejected (dynamic error-class migration, generic delete-record helper).

### Fixed

- Testing a provider connection no longer fails with a generic 500 "Something unexpected interrupted this request" error. Credential reads previously threw an unguarded decryption error whenever the stored key no longer matched the running server's key (for example after a redeploy that reset the key file), which broke both the console's Test action and live account-rotated proxy traffic.

### Added

- Copy action on each provider connection, backed by `GET /console/api/providers/:id/accounts/:accountId/credential`. The secret is fetched only when the operator clicks copy (never in the polled accounts list) and the read is audited.

### Removed

- `POST /console/api/settings/rotate-credential-key` and the credential-key rotation UI.
- The settings Danger Zone section, its "Rotate JWT secret" button, and the "Log out all sessions" button. The `/console/api/settings/rotate-jwt-secret` and `/console/api/settings/logout-all` endpoints remain available.

### Migration

- The `credential_enc` columns are renamed to `credential`. Existing databases carry unreadable ciphertext under the old key, so reset the database (delete `DATA_DIR/cartethyia.sqlite*` and `DATA_DIR/.credential-key`) and re-add provider connections.

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
