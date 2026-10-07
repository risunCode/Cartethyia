# SQLite and PostgreSQL parity

Both backends run the same Drizzle schema (`src/persistence/schema.ts`, written
with `pg-core`) and the same stores. The SQL that differs is meant to live in
`src/persistence/dialect.ts`, and the DDL that differs is derived by
`scripts/generate/sqlite-ddl.ts`. What follows is what that arrangement
actually does, measured against a real SQLite database on 2026-10-07, not
inferred from the types.

The column counts are from `schema.ts`: 18 `boolean`, 15 `jsonb`, 24
`timestamp`, 13 `bigint` (all `mode: "number"`), 3 `numeric`, 12 `pgEnum`.

## What round-trips correctly

Measured by inserting through the Drizzle handle and reading the row back.

| Column | Stored as | Read back | Verdict |
|---|---|---|---|
| `jsonb` | text | parsed object | correct — Drizzle stringifies on write and parses on read |
| `text` enum | text | string | correct |
| `bigint` `mode: "number"` | integer | number | correct inside `Number.MAX_SAFE_INTEGER` (2^53). Every bigint column uses `mode: "number"`, and none holds a value that large: token counters and epoch milliseconds both stay under it |
| `uuid` | text | string | correct |

## What does not round-trip

### `boolean` reads back as a number

Stored as `integer` 0 or 1, which is what the DDL rewrite intends. Read back,
Drizzle returns `1` or `0`, not `true` or `false`. Its `PgBoolean.mapFromDriverValue`
returns the driver value unchanged, and bun:sqlite hands back a number.

Anything that compares a flag with `=== true` is false for a row that is
enabled. Measured on `cli_tool_mappings.enabled`: inserted `true`, read back
`1`. This covers all 18 boolean columns.

### `timestamp` reads back as a string

Stored as ISO text, which is correct. Read back, Drizzle returns the string
`"2026-10-07T06:00:00.000Z"`, not a `Date`. `PgTimestamp.mapFromDriverValue`
only converts a string to a `Date`; bun:sqlite returns the text as text and the
branch never runs.

A caller that formats the value or calls a `Date` method on it throws, and one
that compares it to a `Date` compares a string to an object. This covers all
24 timestamp columns. The login fix (`Date` bindings converted to ISO strings
in `createSqliteDatabase`) made the write direction safe; the read direction
is still wrong.

### `numeric` is not a SQLite type

`rewriteColumn` rewrites `jsonb`, `uuid`, `bytea`, `timestamptz`, and
`boolean`, and does not mention `numeric`. The generated baseline therefore
declares `"estimated_cost_usd" numeric(12, 6)`. SQLite accepts the declaration
and stores the value under the type name `numeric(12, 6)`, which has no
affinity, so the value keeps whatever type it was bound as. The three columns
are `telemetry_events.estimated_cost_usd`, `credit_used`, and `tokens_per_sec`.
The read side was not measured, because the insert needs a tenant row the
probe did not build. The declaration is the defect; the read is unverified.

## What is not a defect

Drizzle's insert builder omits a column the caller did not set, on both
backends. It never sends the JavaScript `.default()`, so a column declared
`.notNull().default(...)` fails the `NOT NULL` constraint when the insert
leaves it out. Measured on `tenants.status` and `telemetry_events.tenant_id`.
PostgreSQL behaves the same way through this builder, so it is not a parity
gap. The database-side `DEFAULT` clause only applies when the column is absent
from the statement entirely, which is the path the raw migration SQL uses.

## Already handled

`src/persistence/dialect.ts` branches the expressions that have no shared
spelling: `mergeJson`, `pruneExpiredCooldowns`, `caseInsensitiveLike`,
`byteLength`, `laterOf`, `currentTimestamp`, `differsFrom`, and the first-boot
lock. `db-sqlite.ts` rewrites `gen_random_uuid()` and `now()` per statement,
converts `Date` bindings to ISO strings, skips an `ADD COLUMN` whose column
already exists, and exposes `execute` (with rows) on both the handle and the
transaction. The generator rewrites the DDL types listed above and drops
`CREATE EXTENSION`, `CREATE TYPE`, `USING btree`, and `DESC`.

A caller that interpolates its own `::jsonb`, `::uuid`, or `octet_length`
bypasses `dialect.ts` and fails on SQLite. `usage-flush.ts` spells
`id::uuid` and `delta::bigint` in its raw statement; that path is not exercised
by the probe above and is unverified on SQLite.
