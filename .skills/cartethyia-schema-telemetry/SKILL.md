---
name: cartethyia-schema-telemetry
description: "Schema and telemetry changes: edit src/persistence/schema.ts, add the next forward migration, or add a usage/telemetry field. Use for migrations, the baseline, telemetry_events/usage_totals, and combo-strategy renames."
---

# Schema and telemetry

Use for a schema change, a migration, or a new usage/telemetry field.

## Schema changes

Migrations run in filename order and are recorded by filename. Never edit a
migration already recorded by a database.

1. Update `src/persistence/schema.ts`.
2. Update `migrations/full-postgres/0000_baseline.sql` for fresh installs.
3. Regenerate the SQLite baseline: `bun scripts/generate/sqlite-ddl.ts`. It
   derives `migrations/lite-sqlite3/0000_baseline.sql` from the PostgreSQL
   baseline, and `test/persistence/sqlite-baseline.test.ts` fails when the two
   disagree. Do not edit the SQLite baseline by hand.
4. Add the next numbered forward migration with idempotent SQL and statement
   breakpoints. The shipped set is the baseline plus `0001`, `0002`, `0003`,
   and `0004`; the next file is `0005`. Do not delete a shipped forward file.
   A forward migration needs a SQLite twin in `migrations/lite-sqlite3/` only when
   an existing SQLite database must converge; a fresh baseline does not.
4. Verify the live schema and migration ledger on an isolated database.

Drizzle numeric columns may require string persistence. Use bigint number mode
for absolute epoch milliseconds. Manual migrations are not applied by the boot
ledger; report them separately.

## Persisted telemetry fields

Per-request events are hourly JSONL under `./data/telemetry-events`
(`src/observability/event-log.ts`). The database keeps aggregates in
`telemetry_usage_totals` only; do not add a reader back onto `telemetry_events`.
Payload capture stays a separate append-only file under
`data/telemetry-payloads/`.

A new usage field must pass through canonical usage, normalization, the file
writer, console contract/store, dashboard validator, and Usage UI. Reject invalid
upstream values; do not silently clamp them. An aggregate that must survive
retention also needs the schema, baseline, and a forward migration.

## Renames and strategy removal

Change the canonical enum/model, router, console contract/store, validation,
catalog snapshot, schema, baseline, migration, dashboard contract/hook/card, and
docs. Apply manual database changes only after verifying the target environment.
No alias fields.

Combo strategies are `fallback` and `round_robin`. There is no fusion strategy
and no minimum-balance floor: do not reintroduce
`model_combo_strategy.fusion`, `credit_limit`, or the account remaining-balance
stamps. Postgres cannot drop one enum value, so removing a strategy means
converting existing rows and rebuilding the type in the forward migration.

## Verify

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
```

Exercise a new migration against an isolated database when available. Never
reset production data — verify the target environment first, and use the
isolated `.env.test` database (`bun run test-db:up/check/down`).
