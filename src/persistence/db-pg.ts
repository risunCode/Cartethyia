/** External-PostgreSQL backend: bounded `pg` Pool behind the shared handle. */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { DEFAULT_BOUNDS } from "../transport/resources";
import { log } from "../observability/logger";
import {
  encodeConnectionComponent,
  formatConnectionHost,
  requireConnectionUrl,
  type ConnectionUrlCandidate,
} from "./connection-url";
import { fullSchema, type CartethyiaDatabase, type DatabaseHandle } from "./db-handle";
import {
  LEDGER_DDL,
  MIGRATION_LEDGER_TABLE,
  migrationFiles,
  resolveMigrationsFolder,
} from "./migrate";
import { basename } from "node:path";
import { readFileSync } from "node:fs";

/** pg-backed handle with the live pool attached for the migration runner. */
export interface PgHandle extends DatabaseHandle {
  readonly kind: "pg";
  readonly pool: Pool;
}

/** Narrows a handle to the pg backend without casting. */
export function isPgHandle(handle: DatabaseHandle): handle is PgHandle {
  return handle.kind === "pg";
}

/**
 * Connection-string sources in resolution order.
 *
 * `DATABASE_URL` is the documented contract and is checked first. The other two
 * are the names a deployment platform may publish instead, because an operator
 * cannot always control which one exists: Railway's Postgres service exposes
 * `DATABASE_URL` next to `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`,
 * and a `${{ Service.VAR }}` reference to a service that does not exist resolves
 * to an empty string rather than failing — which reaches boot as "no database
 * configured at all" and hides a one-word mistake in the service name.
 *
 * Read at call time, not captured at module load: the value is deployment
 * input, and a module-level snapshot would freeze whatever the first import saw.
 */
function databaseUrlCandidates(): readonly ConnectionUrlCandidate[] {
  return [
    { source: "DATABASE_URL", value: process.env.DATABASE_URL },
    { source: "DATABASE_PRIVATE_URL", value: process.env.DATABASE_PRIVATE_URL },
    { source: "DATABASE_PUBLIC_URL", value: process.env.DATABASE_PUBLIC_URL },
  ];
}

/**
 * Assembles the standard libpq variable set into a URL, or `undefined` when it
 * is incomplete. `PGDATABASE` and `PGPASSWORD` are optional: the first defaults
 * upstream, and a passwordless role is a legitimate configuration.
 */
function databaseUrlFromLibpqEnv(): string | undefined {
  const host = process.env.PGHOST?.trim();
  const port = process.env.PGPORT?.trim();
  if (!host || !port) return undefined;
  const user = process.env.PGUSER?.trim();
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE?.trim();
  const authorityHost = formatConnectionHost(host);
  let credentials = "";
  if (user !== undefined && user.length > 0) {
    credentials =
      password === undefined || password.length === 0
        ? `${encodeConnectionComponent(user)}@`
        : `${encodeConnectionComponent(user)}:${encodeConnectionComponent(password)}@`;
  }
  const path =
    database === undefined || database.length === 0 ? "" : `/${encodeConnectionComponent(database)}`;
  return `postgres://${credentials}${authorityHost}:${port}${path}`;
}

export function requireDatabaseUrl(): string {
  return requireConnectionUrl({
    schemes: ["postgres:", "postgresql:"],
    candidates: databaseUrlCandidates(),
    assembled: {
      source: "PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE",
      value: databaseUrlFromLibpqEnv(),
    },
    missing:
      "No Postgres connection string is configured. Set DATABASE_URL to the full URL " +
      "(postgres://user:pass@host:5432/db). On Railway, reference the database service from the " +
      "app service's Variables tab (DATABASE_URL=${{ Postgres.DATABASE_URL }}), spelling the service " +
      "name exactly — a reference to a service that does not exist resolves to an empty string. " +
      "PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE are accepted as an alternative. " +
      "Cartethyia never infers a Docker or Laragon connection automatically.",
  });
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

/**
 * Installs a test pool so code paths that only need the pool's *shape* (such as
 * the capacity check) can run without a server. Mirrors `setRedisForTesting`:
 * the test owns the lifetime and must clear it with `closeDb()`.
 */
export function setPoolForTesting(testPool: Pool): void {
  globalThis.__cartethyiaPool = testPool;
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

async function createMigrationLedger(client: PoolClient): Promise<void> {
  await client.query(LEDGER_DDL);
}

export function createPgHandle(): PgHandle {
  const pool = getPool();
  const db: CartethyiaDatabase = drizzle(pool, { schema: fullSchema });
  return {
    kind: "pg",
    pool,
    db,
    query: async (text: string, params?: readonly unknown[]) => {
      const result = await pool.query(text, [...(params ?? [])]);
      return { rows: result.rows as unknown[] };
    },
    exec: async (script: string) => {
      await pool.query(script);
    },
    close: async () => {
      await pool.end();
    },
  };
}
