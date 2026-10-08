/**
 * Persistence facade: every store imports the database from here and never
 * knows which backend is active. `full` (external PostgreSQL) behaves exactly
 * as before; `lite` (embedded PGlite) is built by the same seam.
 */
import { GatewayError } from "../transport/gateway-error";
import { log } from "../observability/logger";
import { join } from "node:path";
import { fullSchema } from "./db-handle";
import type { CartethyiaDatabase, DatabaseHandle } from "./db-handle";
import { resolveDataDir, resolveDbMode } from "./db-mode";
import {
  applySqlMigrations,
  createPgHandle,
  getPool,
  isPgHandle,
  poolMaxFromEnv,
  requireDatabaseUrl,
  setPoolForTesting,
} from "./db-pg";
import {
  applyPgliteMigrations,
  buildPgliteHandle,
  createPgliteClient,
} from "./db-pglite";
import {
  MIGRATION_LEDGER_TABLE,
  readMigrationLedgerStatus,
} from "./migrate";
import type { MigrationLedgerStatus } from "./migrate";

export { fullSchema };
export type { CartethyiaDatabase, DatabaseHandle, MigrationLedgerStatus };
export {
  MIGRATION_LEDGER_TABLE,
  applySqlMigrations,
  getPool,
  isPgHandle,
  poolMaxFromEnv,
  readMigrationLedgerStatus,
  requireDatabaseUrl,
  setPoolForTesting,
};

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

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaHandle: DatabaseHandle | undefined;
  // eslint-disable-next-line no-var
  var __cartethyiaMigrated: boolean | undefined;
}

/**
 * Builds the active backend handle once. Async because the embedded backend
 * opens its data dir asynchronously; the pg path builds synchronously inside.
 * Safe to call repeatedly — the first handle wins for the process lifetime.
 *
 * Lite boots (open, migrate, handle) in one step: the ledger makes repeat
 * boots cheap, and a handle without migrated tables behind it is never valid.
 */
export async function bootDatabase(): Promise<DatabaseHandle> {
  if (globalThis.__cartethyiaHandle) return globalThis.__cartethyiaHandle;
  if (resolveDbMode() === "lite") {
    const client = await createPgliteClient(join(resolveDataDir(), "pglite"));
    try {
      await applyPgliteMigrations(client);
    } catch (error) {
      await client.close();
      throw error;
    }
    const handle = buildPgliteHandle(client);
    globalThis.__cartethyiaHandle = handle;
    log.warn("[db] lite mode: embedded PGlite, single process only");
    return handle;
  }
  const handle = createPgHandle();
  globalThis.__cartethyiaHandle = handle;
  return handle;
}

/** Active backend handle; throws when the database has not booted yet. */
export function getDbHandle(): DatabaseHandle {
  if (globalThis.__cartethyiaHandle) return globalThis.__cartethyiaHandle;
  if (resolveDbMode() === "lite") {
    throw new Error("Lite database is not booted: await bootDatabase() before getDb()");
  }
  const handle = createPgHandle();
  globalThis.__cartethyiaHandle = handle;
  return handle;
}

export function getDb(): CartethyiaDatabase {
  return getDbHandle().db;
}

export async function ensureMigrated(): Promise<void> {
  if (globalThis.__cartethyiaMigrated) return;
  const handle = await bootDatabase();
  // Lite migrates during boot; pg migrates here under its advisory lock.
  if (isPgHandle(handle)) {
    await applySqlMigrations(handle.pool);
  }
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
  const handle = globalThis.__cartethyiaHandle;
  globalThis.__cartethyiaHandle = undefined;
  globalThis.__cartethyiaMigrated = false;
  if (handle) await handle.close();
}
