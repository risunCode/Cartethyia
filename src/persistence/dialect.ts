/**
 * The SQL that differs between the two backends, in one place.
 *
 * Everything else the stores send is builder output, and that is identical.
 * What remains is a handful of expressions where PostgreSQL has a function
 * SQLite spells differently, or a type SQLite does not have. Each helper
 * returns the expression for the backend that is actually running, so a
 * caller never branches on the mode itself and a third spelling cannot grow
 * beside these two.
 *
 * JSON is `jsonb` on PostgreSQL and `text` on SQLite. The expressions below
 * are the whole of that difference: merge, prune, and compare. A caller that
 * interpolates its own `::jsonb` cast has bypassed this module and will fail
 * on the SQLite backend.
 */
import { sql, type SQL } from "drizzle-orm";
import { resolveDbMode } from "./db-mode";

/** True when the running backend is the embedded SQLite database. */
export function sqliteDialect(): boolean {
  return resolveDbMode() === "lite";
}

/**
 * Merges `patch` over `column`, keeping every key the patch does not mention.
 *
 * PostgreSQL's `||` concatenates jsonb objects. SQLite stores the same value
 * as text, so the merge is `json_patch`, which has the same overwrite-right
 * semantics for objects.
 */
export function mergeJson(column: SQL, patch: SQL): SQL {
  return sqliteDialect()
    ? sql`json_patch(${column}, ${patch})`
    : sql`${column} || ${patch}::jsonb`;
}

/**
 * The per-model cooldown object with every entry whose timestamp has passed
 * removed, or `'{}'` when nothing remains.
 *
 * Both spellings skip a value that is not an object, so a malformed row
 * cannot abort the sweep. The comparison against the current value keeps the
 * update from rewriting rows it did not change, which is what makes the
 * returned row count mean "rows whose cooldown set shrank".
 */
export function pruneExpiredCooldowns(column: SQL, nowIso: SQL): { value: SQL; changed: SQL } {
  if (sqliteDialect()) {
    const kept = sql`COALESCE((SELECT json_group_object(key, value) FROM json_each(${column}) WHERE value > ${nowIso}), '{}')`;
    return {
      value: kept,
      changed: sql`json_valid(${column}) AND json_type(${column}) = 'object' AND ${column} IS NOT (${kept})`,
    };
  }
  const kept = sql`COALESCE((SELECT jsonb_object_agg(entry.key, entry.value) FROM jsonb_each_text(${column}) AS entry WHERE entry.value > ${nowIso}), '{}'::jsonb)`;
  return {
    value: kept,
    changed: sql`jsonb_typeof(${column}) = 'object' AND ${column} IS DISTINCT FROM ${kept}`,
  };
}

/** Case-insensitive substring match. PostgreSQL has `ilike`; SQLite folds both sides. */
export function caseInsensitiveLike(column: SQL, pattern: SQL): SQL {
  return sqliteDialect()
    ? sql`lower(${column}) like lower(${pattern})`
    : sql`${column} ilike ${pattern}`;
}

/** Byte length of a blob column. */
export function byteLength(column: SQL): SQL {
  return sqliteDialect() ? sql`length(${column})` : sql`octet_length(${column})`;
}

/** The later of two timestamps. */
export function laterOf(left: SQL, right: SQL): SQL {
  return sqliteDialect() ? sql`max(${left}, ${right})` : sql`greatest(${left}, ${right})`;
}

/** The current timestamp, in the spelling the backend's default uses. */
export function currentTimestamp(): SQL {
  return sqliteDialect() ? sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` : sql`now()`;
}

/**
 * True when two values differ, treating NULL as a value.
 *
 * PostgreSQL's `IS DISTINCT FROM` does this. SQLite has no equivalent
 * operator, so the comparison is spelled out: differ, or exactly one is NULL.
 */
export function differsFrom(left: SQL, right: SQL): SQL {
  return sqliteDialect()
    ? sql`(${left} IS NOT ${right} OR (${left} IS NULL) != (${right} IS NULL))`
    : sql`${left} IS DISTINCT FROM ${right}`;
}

/**
 * Serialises concurrent first-boot setups on PostgreSQL.
 *
 * SQLite needs nothing here: the setup runs inside a transaction, and a
 * transaction is the write lock. The statement is a no-op select so the call
 * site stays identical.
 */
export function firstBootSetupLock(): SQL {
  return sqliteDialect()
    ? sql`SELECT 1`
    : sql`SELECT pg_advisory_xact_lock(hashtext('cartethyia:first_boot_setup'))`;
}

/**
 * How many rows a raw `execute()` changed.
 *
 * node-postgres reports `rowCount`. bun-sqlite reports `changes`. A result
 * that carries neither changed nothing that can be counted.
 */
export function affectedRows(result: unknown): number {
  if (typeof result !== "object" || result === null) return 0;
  if ("rowCount" in result && typeof result.rowCount === "number") return result.rowCount;
  if ("changes" in result && typeof result.changes === "number") return result.changes;
  return 0;
}
