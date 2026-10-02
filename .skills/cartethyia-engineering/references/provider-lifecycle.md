# Provider lifecycle

Use for adding, removing, importing, authenticating, probing, or curating providers.

## Add a bundled provider

1. Identify the metadata, registry, adapter, auth, catalog, and quota authorities.
2. Add only the provider-specific pieces required by the existing integration family.
3. Preserve required headers, user-agent, body shape, endpoint path, and streaming format.
4. Update intentional dashboard mirrors, config, docs, and `.env.example` entries.
5. Verify through the real composition root, not isolated stubs.

Do not invent capabilities, pricing, limits, or availability when upstream is silent.
A catalog row is not proof that a model answers.

## OAuth and account flows

Redirect URIs must exactly match the allowlist. Refresh-only, device, browser, cookie,
and imported-credential flows have different boundaries; follow the existing family.
Keep credentials server-side and redact them from logs and payload capture.

For OAuth, verify the real browser callback, state single-use behavior, persistence,
refresh registration, and one real request through the account when safe.

## BYOK and custom providers

Derive the wire contract from the compatibility profile. Validate base URL, model,
auth, allowed wire families, and network policy at the server boundary. Dashboard
forms submit data; they do not implement auth or routing policy.

Keep `resolveByokWireProfile` as the authority. Do not re-hardcode authentication or
wire-family mappings in registration, discovery, or connection-test paths.

## Catalog and availability

Keep one metadata source per field. A real authorized probe through the gateway is
required before claiming availability. Distinguish catalog absence, routing failure,
upstream rejection, and entitlement failure.

## Remove a provider

Search registry, adapters, routes, auth, catalog, migrations, dashboard, scripts, and
docs. Remove the canonical definition and migrate callers in one clean cutover. Do
not leave aliases or dead compatibility paths. Check persisted data before deleting
rows; never delete shared models by `model_id` alone, and preserve telemetry history.

## Verification

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when entry/contract changes
```

Exercise the real auth, catalog, and request boundaries when safe. If credentials or
upstream access are unavailable, say so instead of claiming availability.
