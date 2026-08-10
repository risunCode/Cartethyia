# Development

## Source ownership

- `src/middleware/`: unified middleware boundary, method translation, route guards, body limits, and response ownership.
- `src/application/`: contracts, routing, admission, recovery, orchestration.
- `src/auth/`: authentication, credentials, OAuth, token refresh, account health, quota lifecycle.
- `src/providers/`: provider adapters and provider-specific integrations.
- `src/open-sse/`: translation, canonical stream events, codecs, and transport.
- `src/console/`: authenticated control plane.
- `src/storage/`: SQLite persistence.

Provider branches belong in providers. Protocol branches belong in Open-SSE. Account lifecycle belongs in auth.

## Repository layout

```text
src/                 backend runtime
dashboard/           React/Vite console
test/                contract, lifecycle, and load tests
scripts/             operational utilities
docs/                user, operator, and contributor documentation
```

`bin/` and `dashboard/dist/` are build outputs.

## Adding a translator

1. Identify source and target surfaces.
2. Reuse canonical request and stream-event types.
3. Add a codec under `src/open-sse/translate/`.
4. Preserve tools, reasoning, usage, stop reasons, refusals, and images where representable.
5. Reject malformed/oversized input with typed protocol errors.
6. Add non-stream, stream, malformed, truncated, provider-error, and client-abort tests.
7. Register the translator and update capability documentation.

The HTTP boundary must not know provider wire details.

## Adding a provider

Add metadata, adapter, registry entry, models, capabilities, request/stream decoding, error classification, tests, and provider documentation. Keep quota API calls under `src/providers/quota/`; keep scheduling under `src/auth/`.

## Testing

```bash
bunx tsc --noEmit
bun run test
cd dashboard && bun run test && bun run build
```

Tests should assert observable contracts: status, response shape, event ordering, retryability, persistence, cleanup, and capacity behavior. Use deterministic fixtures for provider-independent tests.

## Release process

1. Update version/changelog for user-visible changes.
2. Run backend typecheck and full tests.
3. Run dashboard typecheck, tests, and build.
4. Build the server binary and probe startup plus `/health`.
5. Review routes, providers, migrations, and secret handling.
6. Build Docker when the container path changed.
7. Verify one authenticated request and deployment persistence.
8. Record compatibility or migration notes.
