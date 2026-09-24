import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { DEFAULT_BOUNDS } from "../transport/resources";
import { GatewayError } from "../transport/gateway-error";
import * as schema from "./schema";
import { log } from "../observability/logger";
/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505).
 *
 * Lives at the persistence boundary because it is a fact about the driver's
 * error shape, not about any one domain. It walks a bounded `cause` chain
 * because Drizzle wraps driver errors, so the SQLSTATE is not always on the
 * error the caller catches.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === "23505") return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}


/** Complete Drizzle schema object: every table across the single schema source. */
export const fullSchema = schema;

export type CartethyiaDatabase = NodePgDatabase<typeof fullSchema>;


/**
 * The single persistence boundary.
 * - `DATABASE_URL` is the ONLY source of the Postgres connection string
 *   (no Docker/Laragon/service-name detection).
 * - A bounded `pg` Pool is reused by the single `drizzle()` instance.
 * - PgBouncer transaction-pooling compatibility is preserved by avoiding
 *   session-level state (no `SET LOCAL` without explicit transaction scope
 *   handled by the caller, no `LISTEN`/`NOTIFY`, no advisory-lock-held-
 *   across-queries pattern at this layer).
 * - Shutdown is symmetric: callers close the Pool; drizzle has no separate
 *   resource to close.
 */

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db). " +
        "Cartethyia never infers a Docker or Laragon connection automatically.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL: ${url}`);
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error(
      `DATABASE_URL must include explicit host and port (got hostname="${parsed.hostname}" port="${parsed.port}")`,
    );
  }
  return url;
}

export function poolMaxFromEnv(): number {
  const raw = process.env.DATABASE_POOL_MAX ?? String(DEFAULT_BOUNDS.maxPostgresPoolSize);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`DATABASE_POOL_MAX must be a positive integer (got "${raw}")`);
  }
  return value;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __cartethyiaDb: CartethyiaDatabase | undefined;
}

/** Postgres session tuning applied to every checked-out client. Kept as
 *  server-side `SET` statements — cheap on assign, honored by PgBouncer
 *  transaction pooling, and survives the connection lifetime. */
const SESSION_STATEMENT_TIMEOUT_MS = Number(
  process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 30_000,
);
const SESSION_IDLE_IN_TXN_TIMEOUT_MS = Number(
  process.env.DATABASE_IDLE_IN_TXN_TIMEOUT_MS ?? 60_000,
);
const SESSION_LOCK_TIMEOUT_MS = Number(process.env.DATABASE_LOCK_TIMEOUT_MS ?? 5_000);

export function getPool(): Pool {
  if (globalThis.__cartethyiaPool) return globalThis.__cartethyiaPool;
  const pool = new Pool({
    connectionString: requireDatabaseUrl(),
    max: poolMaxFromEnv(),
    // A larger idle pool avoids reconnect churn under bursty 10k-inflight
    // traffic; 60s matches Postgres's default TCP keepalive window.
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 5_000,
    // Kill runaway queries so one bad row-hunting SELECT does not pin a
    // backend the admission gate is already counting on being free.
    statement_timeout: SESSION_STATEMENT_TIMEOUT_MS,
    // Reap forgotten open transactions before they hold row locks that
    // stall every other tenant sharing the pool.
    idle_in_transaction_session_timeout: SESSION_IDLE_IN_TXN_TIMEOUT_MS,
    lock_timeout: SESSION_LOCK_TIMEOUT_MS,
    // Keep TCP alive on the client side too — cheap insurance against
    // idle-connection drops from intermediaries.
    keepAlive: true,
  } as ConstructorParameters<typeof Pool>[0]);
  pool.on("error", (err) => {
    log.error("[postgres] pool error (idle client)", err);
  });
  globalThis.__cartethyiaPool = pool;
  return pool;
}

export function getDb(): CartethyiaDatabase {
  if (globalThis.__cartethyiaDb) return globalThis.__cartethyiaDb;
  globalThis.__cartethyiaDb = drizzle(getPool(), { schema: fullSchema });
  return globalThis.__cartethyiaDb;
}

/**
 * Installs a test pool so code paths that only need the pool's *shape* (such as
 * the capacity check) can run without a server. Mirrors `setRedisForTesting`:
 * the test owns the lifetime and must clear it with `closeDb()`.
 */
export function setPoolForTesting(testPool: Pool): void {
  globalThis.__cartethyiaPool = testPool;
}

declare global {
  // eslint-disable-next-line no-var
  var __cartethyiaMigrated: boolean | undefined;
}

/**
 * SQL-only migration ledger. Migration files are the source of truth; this
 * table stores only which numbered files have already run.
 */
export const MIGRATION_LEDGER_TABLE = "cartethyia_schema_migrations";

function resolveMigrationsFolder(): string {
  const folder =
    process.env.NODE_ENV === "production"
      ? resolve(process.cwd(), "migrations")
      : resolve(import.meta.dir, "../../drizzle/migrations");
  if (!existsSync(folder)) {
    throw new Error(`Migrations folder not found: ${folder}`);
  }
  return folder;
}

function migrationFiles(folder: string): readonly string[] {
  return readdirSync(folder)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .map((file) => resolve(folder, file));
}

async function createMigrationLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
      migration_id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** Applies numbered SQL files in order under one cross-process advisory lock. */
export async function applySqlMigrations(
  pool: Pool,
  folder = resolveMigrationsFolder(),
): Promise<void> {
  const files = migrationFiles(folder);
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('cartethyia:migrations'))`);
    await createMigrationLedger(client);
    const appliedRows = await client.query<{ migration_id: string }>(
      `SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`,
    );
    const applied = new Set(appliedRows.rows.map((row) => row.migration_id));

    for (const file of files) {
      const migrationId = basename(file);
      if (applied.has(migrationId)) continue;
      const sql = readFileSync(file, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATION_LEDGER_TABLE} (migration_id) VALUES ($1)`,
          [migrationId],
        );
        await client.query("COMMIT");
        applied.add(migrationId);
      } catch (error) {
        // Rollback on migration failure is best-effort before throwing.
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${migrationId} failed: ${String(error)}`, {
          cause: error,
        });
      }
    }
  } finally {
    // Advisory unlock during migration teardown is best-effort.
    await client
      .query(`SELECT pg_advisory_unlock(hashtext('cartethyia:migrations'))`)
      .catch(() => {});
    client.release();
  }
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
 */
export async function readMigrationLedgerStatus(
  db: CartethyiaDatabase,
  folder: string = resolveMigrationsFolder(),
): Promise<MigrationLedgerStatus> {
  const expected = migrationFiles(folder).map((file) => basename(file));
  const result = await db.execute<{ migration_id: string }>(
    sql.raw(`SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`),
  );
  const applied = new Set(result.rows.map((row) => row.migration_id));
  const pending = expected.filter((migrationId) => !applied.has(migrationId));
  return { expected, pending, applied: pending.length === 0 };
}

export async function ensureMigrated(): Promise<void> {
  if (globalThis.__cartethyiaMigrated) return;
  await applySqlMigrations(getPool());
  globalThis.__cartethyiaMigrated = true;
}

/**
 * Reports how many gateway processes this server's connection budget supports.
 *
 * The gateway is designed to run several processes against one port
 * (`reusePort` in `main.ts`), and each process opens its own pool of
 * `DATABASE_POOL_MAX` connections. Nothing in a single process can see its
 * siblings, so the only honest thing to do is tell the operator the arithmetic
 * they cannot see from the config file: with `poolMax` per process and
 * `max_connections` on the server, how many processes fit.
 *
 * A pool that alone meets or exceeds the server ceiling is unambiguously
 * broken even for one process, so that fails the boot. Anything else is a
 * warning with the usable process count, because a single-process deployment
 * is legitimate and the operator — not this process — knows how many they run.
 */
export async function assertPoolFitsServerCapacity(poolMax: number): Promise<void> {
  let serverMax: number;
  try {
    const result = await getPool().query<{ max_connections: string }>("SHOW max_connections");
    serverMax = Number(result.rows[0]?.max_connections);
  } catch (error) {
    // Capacity is a diagnostic, not a correctness requirement: a server that
    // refuses `SHOW` (restricted role) must not stop the gateway from serving.
    log.warn("[postgres] could not read max_connections; skipping pool capacity check", error);
    return;
  }
  if (!Number.isFinite(serverMax) || serverMax < 1) return;

  if (poolMax >= serverMax) {
    throw new GatewayError(
      "max_connections_exceeded",
      500,
      `DATABASE_POOL_MAX (${poolMax}) must be below the server's max_connections (${serverMax}); ` +
        "a single process could not serve a full pool, and every other connection would be refused",
      { pool_max: poolMax, max_connections: serverMax },
    );
  }

  const processes = Math.floor(serverMax / poolMax);
  if (processes < 2) {
    log.warn(
      `[postgres] DATABASE_POOL_MAX=${poolMax} leaves room for only ${processes} gateway process ` +
        `on a server with max_connections=${serverMax}; a second process would exhaust the budget`,
      { pool_max: poolMax, max_connections: serverMax, processes },
    );
    return;
  }
  log.info(
    `[postgres] pool budget: ${processes} gateway processes fit ` +
      `(DATABASE_POOL_MAX=${poolMax}, max_connections=${serverMax})`,
  );
}

export async function closeDb(): Promise<void> {
  if (globalThis.__cartethyiaPool) {
    const p = globalThis.__cartethyiaPool;
    globalThis.__cartethyiaPool = undefined;
    globalThis.__cartethyiaDb = undefined;
    globalThis.__cartethyiaMigrated = false;
    await p.end();
  }
}
