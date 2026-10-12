# SQLite and PostgreSQL parity

Both backends run the same Drizzle schema (`src/persistence/schema.ts`, written
with `pg-core`) and the same stores. SQL expressions that differ are meant to
live in `src/persistence/dialect.ts`. The SQLite baseline is generated from the
PostgreSQL baseline by `scripts/generate/sqlite-ddl.ts`; forward migrations are
maintained as paired SQL files in `migrations/full-postgres/` and
`migrations/lite-sqlite3/`. `test/persistence/sqlite-baseline.test.ts` checks
that the baselines and migration filenames stay in sync. What follows is what
that arrangement actually does, measured against a real SQLite database on
2026-10-07, not inferred from the types.

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
| `boolean` | integer 0 or 1 | `true` or `false` | correct, since the column mapping in `db-sqlite.ts` |
| `timestamp` | ISO text | `Date` | correct, since the same mapping. A row holding epoch milliseconds, as a number or as its digits, reads back as that instant too |
| `numeric` | real | string | correct. Drizzle's numeric mapper stringifies the value, which is what the column declares. The scale is not stored: `numeric(12, 6)` is a bare type name to SQLite and the value keeps no trailing zeroes, so `"2.50"` reads back as `"2.5"`. The digits survive, including `"0.000001"` |
| `bytea` | blob | `Uint8Array` | the bytes survive, including a leading `0` and a `255`. The schema declares `Buffer` and bun:sqlite returns a `Uint8Array`, which is not a `Buffer`. Every current reader accepts both: `decryptCredential` branches on `Buffer.isBuffer`, and the popup image path takes a `Uint8Array`. A new reader that calls `Buffer.isBuffer` on a value it read will be wrong |

## What does not round-trip

Nothing measured on 2026-10-07 fails to round-trip. The `bytea` type difference
above is the one that will bite a future reader; it does not bite a current one.

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
converts `Date` bindings to ISO strings, maps boolean and timestamp
columns back to the types the schema declares (`installSqliteColumnMapping`),
skips an `ADD COLUMN` whose column already exists, and exposes `execute` (with
rows) on both the handle and the transaction. The generator rewrites the DDL types listed above and drops
`CREATE EXTENSION`, `CREATE TYPE`, `USING btree`, and `DESC`.

A caller that interpolates its own `::jsonb`, `::uuid`, or `octet_length`
bypasses `dialect.ts` and fails on SQLite. `usage-flush.ts` is the one caller
that spells those casts, and it branches: PostgreSQL gets
`UPDATE ... FROM (VALUES ...)` with `::uuid` and `::bigint`, SQLite gets a
`SELECT ... UNION ALL` with neither, because SQLite rejects `UPDATE ... FROM`.
That branch is exercised by `test/persistence/usage-flush.test.ts`, which
flushes 25 keys in one statement on a migrated SQLite file and reads the
totals back.

## Measured and ruled out

Each of these was a suspected gap. All were measured on a migrated SQLite
file, and the tests in `test/persistence/sqlite-type-parity.test.ts` and
`test/console/sqlite-login-readback.test.ts` lock the ones that can regress.

- A boolean stored as `NULL` reads back as `null`, not as `0` or `false`. The
  mapping only rewrites `1` and `0`.
- A timestamp holding epoch milliseconds reads back as that instant. The
  column is `text`, so the number is stored as its digits, and `new Date`
  reads a digit string as a year and returns an invalid date. The mapping
  treats an all-digit string as milliseconds before the ISO conversion.
- `numeric` reads back as a string with its significant digits intact. The
  declaration `numeric(12, 6)` gives SQLite no affinity and no scale, which
  looks like a defect and is not one: the value is what the column promises,
  and only the trailing zeroes are lost.
- `usage-flush.ts` does not send `::uuid` or `::bigint` to SQLite. See above.
- The payload frame store is not a database column. `telemetry_payloads`
  holds a pointer; the body is a gzipped frame in a file, named `jsonl-file`,
  and a frame written before compression stays readable as `jsonb-file`.
- `db.execute` returns the same types the query builder returns. It used to
  read through `prepare().all()` and hand back stored values, so a timestamp
  came back as text and a boolean as `0` or `1` — the same mismatch that
  rejected a correct login, on the one read the backup import uses to decide
  whether a row already exists. It now maps each column through the same
  function the builder calls. A statement that reads one table is mapped; a
  `SELECT 1` or a join is returned as stored, because no single table owns
  its columns. The same change binds interpolated values: the alias used to
  join the SQL text and drop every parameter, so a statement with a `${}`
  value reached SQLite with a hole in it.
