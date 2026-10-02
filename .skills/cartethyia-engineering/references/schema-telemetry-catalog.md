# Schema, telemetry, and model catalog

## Schema changes

Migrations run in filename order and are recorded by filename. Never edit a
migration already recorded by a database.

1. Update `src/persistence/schema.ts`.
2. Update `migrations/0000_baseline.sql` for fresh installs.
3. Add the next numbered forward migration with idempotent SQL and statement
   breakpoints.
4. Verify the live schema and migration ledger on an isolated database.

Drizzle numeric columns may require string persistence. Use bigint number mode for
absolute epoch milliseconds. Manual migrations are not applied by the boot ledger;
report them separately.

## Persisted telemetry fields

A new usage field must pass through canonical usage, normalization, schema/baseline/
forward migration, telemetry writer, console contract/store, dashboard validator,
and Usage UI. Reject invalid upstream values; do not silently clamp them.

## Renames and strategy removal

Change the canonical enum/model, router, console contract/store, validation, catalog
snapshot, schema, baseline, migration, dashboard contract/hook/card, and docs. Apply
manual database changes only after verifying the target environment. No alias fields.

## Model catalog

- OpenCode Zen is id-oriented; models.dev carries rich metadata.
- `src/providers/discovery/base-models.json` is the offline catalog authority.
- Provider-id remaps live in `MODELS_DEV_PROVIDER_IDS`.
- `/v1/models` omits unavailable optional fields rather than emitting null.
- Capabilities are normalized to `text | image | audio | video | pdf` at emission.
- Pool capabilities and pricing are claims about every member, not one member.
- Catalog presence is not availability; use an authorized real probe.

## In-flight requests

The registry is owned by `ProxyRequestStateStore`; `state.cleanup()` is the single
idempotent release point. Streaming cleanup must cover normal completion, errors,
cancel, client abort, deadline/stall abort, and iterator return. A pending pull owns
its terminal outcome; do not release twice. The periodic backstop releases overdue
state that a disconnect shape failed to tear down.

Diagnose with the live in-flight endpoint and a real streaming reproduction that stops
reading before aborting. Confirm the gauge returns to zero and leases/slots release.

## Reasoning replay

Messages thinking blocks, chat `reasoning_content`, and Responses reasoning items are
one canonical reasoning part. Preserve presence even when text is empty; never
fabricate an empty field. Keep reasoning on assistant/tool-call turns, and handle
both Responses summary/content text fields and both streaming delta event names.

Read the captured request shape before editing. Re-run the same real pipeline shape
after the fix; delete temporary diagnostics.

## Verification

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when entry/contract changes
```
