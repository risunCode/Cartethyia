/** Migration discovery + ledger helpers shared by every database backend. */
import { sql } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolvePackagePath } from "../config/package-paths";
import type { CartethyiaDatabase } from "./db-handle";

/**
 * SQL-only migration ledger. Migration files are the source of truth; this
 * table stores only which numbered files have already run.
 */
export const MIGRATION_LEDGER_TABLE = "cartethyia_schema_migrations";

export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  migration_id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export function resolveMigrationsFolder(): string {
  const folder = resolvePackagePath("migrations", "full-postgres");
  if (!existsSync(folder)) {
    throw new Error(`Migrations folder not found: ${folder}`);
  }
  return folder;
}

export function migrationFiles(folder: string): readonly string[] {
  return readdirSync(folder)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .map((file) => resolve(folder, file));
}

export function migrationIdFor(file: string): string {
  return basename(file);
}

/** The file a fresh database builds from. An older database already has its tables. */
export const BASELINE_MIGRATION_ID = "0000_baseline.sql";

/**
 * True when this database was built by a baseline this release no longer ships.
 *
 * The ledger names that file, and `tenants` exists, so the current baseline must
 * be recorded rather than executed: executing it would try to create tables the
 * database already has. The numbered files after it converge the old shape.
 */
export function baselineAlreadySatisfied(
  applied: ReadonlySet<string>,
  hasTenants: boolean,
): boolean {
  return hasTenants && !applied.has(BASELINE_MIGRATION_ID);
}

/**
 * Splits a migration file on the drizzle `statement-breakpoint` markers the
 * files already carry. Only the embedded backend needs per-statement
 * application (single-statement failure tolerance); the pg path sends the
 * whole file at once exactly as before.
 */
export function splitStatements(source: string): string[] {
  return source
    .split(/--> statement-breakpoint/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Readiness view of the migration ledger: the numbered SQL files discovered on
 * disk compared against the ids recorded in {@link MIGRATION_LEDGER_TABLE}.
 */
export interface MigrationLedgerStatus {
  /** Migration file names discovered on disk, in apply order. */
  readonly expected: readonly string[];
  /** Expected migrations that have no ledger row. */
  readonly pending: readonly string[];
  /** True only when every expected migration is recorded in the ledger. */
  readonly applied: boolean;
}

/**
 * Compares the migration files discovered on disk against the applied-migration
 * ledger. A reachable ledger alone is not readiness: an interrupted upgrade
 * leaves the table present while later migrations are still unapplied.
 *
 * Runs on the drizzle handle, so it is identical on every backend.
 */
export async function readMigrationLedgerStatus(
  db: CartethyiaDatabase,
  folder: string = resolveMigrationsFolder(),
): Promise<MigrationLedgerStatus> {
  const expected = migrationFiles(folder).map((file) => migrationIdFor(file));
  const result = await db.execute<{ migration_id: string }>(
    sql.raw(`SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`),
  );
  const applied = new Set(result.rows.map((row) => row.migration_id));
  const pending = expected.filter((migrationId) => !applied.has(migrationId));
  return { expected, pending, applied: pending.length === 0 };
}


