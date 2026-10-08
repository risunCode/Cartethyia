/** Embedded-PostgreSQL backend: PGlite in the gateway's data dir. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { mkdirSync, readFileSync } from "node:fs";
import { fullSchema, type CartethyiaDatabase, type DatabaseHandle } from "./db-handle";
import {
  isToleratedMissingExtension,
  LEDGER_DDL,
  MIGRATION_LEDGER_TABLE,
  migrationFiles,
  migrationIdFor,
  resolveMigrationsFolder,
  splitStatements,
} from "./migrate";

/** Minimal transaction surface the migration runner needs. */
interface PgliteTx {
  exec: (sql: string) => Promise<unknown>;
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

interface PgliteWithTransaction {
  transaction: (fn: (tx: PgliteTx) => Promise<void>) => Promise<void>;
}

function hasTransaction(client: unknown): client is PgliteWithTransaction {
  return (
    typeof client === "object" &&
    client !== null &&
    "transaction" in client &&
    typeof client.transaction === "function"
  );
}

/** Opens the embedded database at `dataDir`. Filesystem paths are created; URI backends (`memory://`) are used as-is. The caller owns `close()`. */
export async function createPgliteClient(dataDir: string): Promise<PGlite> {
  if (!dataDir.includes("://")) mkdirSync(dataDir, { recursive: true });
  return PGlite.create({ dataDir });
}

export function buildPgliteHandle(client: PGlite): DatabaseHandle {
  // Same pg-core PgDatabase base over the same schema as the pg driver; only
  // the session differs, so the instance is converted once here instead of
  // forcing a driver union through every store.
  const db = drizzle(client, { schema: fullSchema }) as unknown as CartethyiaDatabase;
  return {
    kind: "pglite",
    db,
    query: async (text: string, params?: readonly unknown[]) => {
      const result = await client.query(text, params === undefined ? [] : [...params]);
      return { rows: result.rows as unknown[] };
    },
    exec: async (script: string) => {
      await client.exec(script);
    },
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Applies numbered SQL files in order, mirroring the pg runner's semantics:
 * same ledger table, applied files skipped, one file applied atomically, same
 * `Migration ${id} failed` error shape.
 *
 * Two deliberate divergences, both single-process consequences: no advisory
 * lock (a second process cannot open the same data dir — the Postgres lock
 * file refuses it), and one tolerated skip — `CREATE EXTENSION` for an
 * extension PGlite does not bundle (`pgcrypto`; no migration or query calls
 * its functions, every hash is `node:crypto`, and PG core provides
 * `gen_random_uuid()`).
 */
export async function applyPgliteMigrations(
  client: PGlite,
  folder = resolveMigrationsFolder(),
): Promise<void> {
  if (!hasTransaction(client)) {
    throw new Error("PGlite client does not expose transaction()");
  }
  await client.exec(LEDGER_DDL);
  const appliedRows = await client.query<{ migration_id: string }>(
    `SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`,
  );
  const applied = new Set(appliedRows.rows.map((row) => row.migration_id));

  for (const file of migrationFiles(folder)) {
    const migrationId = migrationIdFor(file);
    if (applied.has(migrationId)) continue;
    const source = readFileSync(file, "utf8");
    try {
      await client.transaction(async (tx) => {
        // One savepoint per statement: a tolerated failure (unbundled
        // extension) rolls back to the savepoint instead of poisoning the
        // file's transaction, while any other failure still aborts it.
        for (const statement of splitStatements(source)) {
          await tx.exec("SAVEPOINT cartethyia_stmt");
          try {
            await tx.exec(statement);
          } catch (error) {
            await tx.exec("ROLLBACK TO SAVEPOINT cartethyia_stmt");
            if (isToleratedMissingExtension(statement, error)) continue;
            throw error;
          }
          await tx.exec("RELEASE SAVEPOINT cartethyia_stmt");
        }
        await tx.query(`INSERT INTO ${MIGRATION_LEDGER_TABLE} (migration_id) VALUES ($1)`, [
          migrationId,
        ]);
      });
      applied.add(migrationId);
    } catch (error) {
      throw new Error(`Migration ${migrationId} failed: ${String(error)}`, { cause: error });
    }
  }
}
