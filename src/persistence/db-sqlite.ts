/** Embedded backend: bun:sqlite in the gateway's data dir. */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fullSchema, type DatabaseHandle } from "./db-handle";
import {
  BASELINE_MIGRATION_ID,
  baselineAlreadySatisfied,
  MIGRATION_LEDGER_TABLE,
  migrationFiles,
  migrationIdFor,
  splitStatements,
} from "./migrate";

/**
 * Ledger DDL for the SQLite backend.
 *
 * The shared ledger DDL is PostgreSQL (`timestamptz`, `now()`), and this
 * backend never sends PostgreSQL DDL. The shape is the same table the
 * readiness check reads, so a ledger written here is a ledger read there.
 */
const SQLITE_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  migration_id text PRIMARY KEY,
  applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

/**
 * Opens the embedded database at `file`.
 *
 * `:memory:` is the test backend and is used as given. A filesystem path has
 * its parent created first, because bun:sqlite does not create directories.
 * Foreign keys are off unless asked for, so the pragma is set on every
 * connection rather than trusted to a default. WAL keeps a reader from
 * blocking the single writer.
 */
export function createSqliteDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") applyFilePragmas(db);
  // Installed before anything prepares a statement, so every caller — the
  // handle, Drizzle, a test wrapping `exec` — sees SQL SQLite can run.
  const prepare = db.prepare.bind(db);
  db.prepare = ((text: string) => {
    const statement = prepare(sqliteSql(text));
    // bun:sqlite rejects a Date binding ("Binding expected string, TypedArray,
    // boolean, number, bigint or null"), and Drizzle's pg-core timestamp
    // columns bind `Date` objects. The schema is shared with PostgreSQL, so
    // the conversion lives here: every timestamp column is `text`, and an ISO
    // string is exactly what those columns store.
    const bind = (value: unknown): SQLQueryBindings =>
      value instanceof Date ? value.toISOString() : (value as SQLQueryBindings);
    const run = statement.run.bind(statement);
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    // Drizzle's bun-sqlite session reads rows through `values`, not `all`.
    const values = statement.values.bind(statement);
    const bound = (args: unknown[]): SQLQueryBindings[] => args.map(bind);
    statement.run = ((...args: unknown[]) => run(...bound(args))) as typeof statement.run;
    statement.all = ((...args: unknown[]) => all(...bound(args))) as typeof statement.all;
    statement.get = ((...args: unknown[]) => get(...bound(args))) as typeof statement.get;
    statement.values = ((...args: unknown[]) => values(...bound(args))) as typeof statement.values;
    return statement;
  }) as Database["prepare"];
  const exec = db.exec.bind(db);
  db.exec = ((text: string) => exec(sqliteSql(text))) as Database["exec"];
  return db;
}

/**
 * The handle stores run on.
 *
 * `db` is the bun-sqlite Drizzle instance. It is not the node-postgres
 * `CartethyiaDatabase` the stores are typed against — the two query builders
 * are different types — so the conversion happens once, here. The stores
 * exercise only the builder surface both drivers share.
 */
/**
 * The three statements the auth path runs on a cache miss, prepared once.
 *
 * Drizzle rebuilds the query on every call, and that rebuild measured 60x the
 * cost of the lookup itself. These are static SQL against an index, so there
 * is nothing for a builder to decide per call. The column list is exactly the
 * `api_keys` row the store maps, in the order `findActiveByHash` reads it.
 */
const AUTH_KEY_COLUMNS = [
  "id", "tenant_id", "key_hash", "key_mode", "parent_key_id", "issued_client_ip",
  "issued_client_ip_key", "label", "scopes", "requests_per_minute", "daily_token_limit",
  "monthly_token_limit", "lifetime_token_budget", "lifetime_tokens_consumed",
  "max_concurrent_requests", "model_access_mode", "model_list", "client_router_denylist",
  "model_prefix", "created_at", "enabled", "revoked_at", "key_prefix", "key_encrypted",
  "notes_title", "notes_subtitle", "notes_body", "is_default", "sort_index",
].join(", ");

export interface SqliteAuthStatements {
  /** One active key by its hash. The auth path's first read. */
  readonly byHash: { get: (hash: string) => Record<string, unknown> | null };
  /** One active key by its id. Run only for a key that has a parent. */
  readonly byId: { get: (id: string) => Record<string, unknown> | null };
  /** Lifetime consumption across one key's children, revoked included. */
  readonly childrenConsumed: { get: (parentId: string) => { total: number } | null };
}

export function prepareAuthStatements(sqlite: Database): SqliteAuthStatements {
  const active = `enabled = 1 AND revoked_at IS NULL`;
  return {
    byHash: sqlite.prepare(
      `SELECT ${AUTH_KEY_COLUMNS} FROM api_keys WHERE key_hash = ? AND ${active} LIMIT 1`,
    ) as SqliteAuthStatements["byHash"],
    byId: sqlite.prepare(
      `SELECT ${AUTH_KEY_COLUMNS} FROM api_keys WHERE id = ? AND ${active} LIMIT 1`,
    ) as SqliteAuthStatements["byId"],
    childrenConsumed: sqlite.prepare(
      `SELECT coalesce(sum(lifetime_tokens_consumed), 0) AS total FROM api_keys WHERE parent_key_id = ?`,
    ) as SqliteAuthStatements["childrenConsumed"],
  };
}

export function buildSqliteHandle(sqlite: Database): DatabaseHandle {
  const built = drizzle(sqlite, { schema: fullSchema });
  // node-postgres exposes `execute` for raw SQL. bun-sqlite exposes `run` and
  // `all` instead, and the stores were written against `execute`. The alias
  // goes through `exec` rather than `run`: `run` prepares a statement per
  // call, and a raw statement here carries its values inlined, so there is
  // nothing to bind. Affected rows are read back from `changes()`.
  const execute = (query: unknown): { rowCount: number; rows: unknown[] } => {
    const rendered = (query as { queryChunks?: { value?: string[] }[] }).queryChunks
      ?.flatMap((chunk) => chunk.value ?? [])
      .join("");
    if (rendered === undefined) throw new Error("sqlite execute: query has no SQL text");
    // `all` for a statement that returns rows, `exec` otherwise. Readiness
    // reads the migration ledger through `execute` and decides "applied" from
    // `result.rows`; an alias that only reported `changes()` made every select
    // look empty, so a migrated database stayed "not ready" forever.
    const returnsRows = /^\s*(select|with|pragma)\b/i.test(rendered);
    if (returnsRows) {
      const rows = sqlite.prepare(rendered).all();
      return { rowCount: rows.length, rows };
    }
    sqlite.exec(rendered);
    const changed = sqlite.prepare("SELECT changes() AS c").get() as { c: number } | null;
    return { rowCount: changed?.c ?? 0, rows: [] };
  };
  // A transaction callback receives a fresh builder, not this handle, so the
  // `execute` alias above would not reach it. First-boot setup takes its lock
  // through `transaction.execute`, and without the alias that call throws and
  // setup can never complete on the SQLite backend.
  const transaction = built.transaction.bind(built);
  const db = Object.assign(built, {
    execute,
    transaction: (fn: (tx: unknown) => unknown) =>
      transaction((tx: object) => fn(Object.assign(tx, { execute }))),
  });
  return {
    kind: "sqlite",
    db: db as unknown as DatabaseHandle["db"],
    auth: prepareAuthStatements(sqlite),
    query: (text, params) => {
      // bun:sqlite types `all` as a tuple spread, which a `readonly unknown[]`
      // cannot satisfy. The values are the bound parameters the caller built;
      // the cast is confined to this one call.
      const bound = (params ?? []) as Parameters<ReturnType<Database["prepare"]>["all"]>;
      const rows = sqlite.prepare(text).all(...bound) as unknown[];
      return Promise.resolve({ rows });
    },
    exec: (script) => {
      sqlite.exec(script);
      return Promise.resolve();
    },
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
}

/**
 * Applies the SQLite migration set in order.
 *
 * Same ledger, same skip-when-recorded rule, and the same one-file-per-
 * transaction atomicity as the PostgreSQL runner. Two deliberate absences,
 * both consequences of being the only process: no advisory lock, because a
 * second process cannot open the file for writing, and no
 * `to_regclass` probe, because SQLite has no schemas — `sqlite_master`
 * answers the same question.
 */
/**
 * Rewrites the two PostgreSQL functions the schema's defaults emit.
 *
 * `gen_random_uuid()` becomes a quoted uuid. `now()` becomes a quoted UTC
 * timestamp. Both are matched only as function calls, so a column or string
 * that merely contains the words is left alone.
 */
/**
 * Rewrites the two PostgreSQL functions the schema's defaults emit, and only
 * those. A statement that contains neither is returned as-is, so the common
 * case — every read, and every write that supplies its own values — pays one
 * `includes` and nothing else.
 */
function sqliteSql(text: string): string {
  if (!text.includes("gen_random_uuid()") && !text.includes("now()")) return text;
  return text
    .replaceAll("gen_random_uuid()", () => `'${randomUUID()}'`)
    .replaceAll("now()", () => `'${new Date().toISOString()}'`);
}

/**
 * Pragmas for a file-backed database. Each one removes a stall or a fsync the
 * default pays per commit, and none of them weakens crash safety below what
 * the usage flush already accepts (at most the last second of deltas).
 *
 * `synchronous = NORMAL` is durable against a process crash under WAL; only a
 * power loss can drop the last commit. `busy_timeout` makes a writer wait
 * instead of failing instantly when a sweep holds the lock. The cache is 64 MB,
 * enough to hold the auth and catalog working set. `temp_store` keeps sorts
 * off disk. The checkpoint interval keeps a request from stalling on one.
 */
function applyFilePragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA cache_size = -65536");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
}

/** The SQLite set lives beside the PostgreSQL one, never inside it. */
export function resolveSqliteMigrationsFolder(): string {
  return resolve(process.cwd(), "migrations", "lite-sqlite3");
}

export async function applySqliteMigrations(
  sqlite: Database,
  folder = resolveSqliteMigrationsFolder(),
): Promise<void> {
  sqlite.exec(SQLITE_LEDGER_DDL);
  const appliedRows = sqlite
    .prepare(`SELECT migration_id FROM ${MIGRATION_LEDGER_TABLE}`)
    .all() as { migration_id: string }[];
  const applied = new Set(appliedRows.map((row) => row.migration_id));

  const tenants = sqlite
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tenants'")
    .get() as { present: number } | null;
  if (baselineAlreadySatisfied(applied, tenants !== null)) {
    sqlite
      .prepare(`INSERT INTO ${MIGRATION_LEDGER_TABLE} (migration_id) VALUES (?) ON CONFLICT DO NOTHING`)
      .run(BASELINE_MIGRATION_ID);
    applied.add(BASELINE_MIGRATION_ID);
  }

  for (const file of migrationFiles(folder)) {
    const migrationId = migrationIdFor(file);
    if (applied.has(migrationId)) continue;
    const source = readFileSync(file, "utf8");
    const record = sqlite.prepare(
      `INSERT INTO ${MIGRATION_LEDGER_TABLE} (migration_id) VALUES (?)`,
    );
    try {
      sqlite.transaction(() => {
        for (const statement of splitStatements(source)) {
          // The generated baseline opens with a comment block, and a
          // breakpoint at the end of a file leaves an empty part. `exec`
          // rejects both, so only text that still contains SQL is sent.
          const sql = statement.replace(/--[^\n]*/g, "").trim();
          if (sql.length === 0) continue;
          // `ADD COLUMN IF NOT EXISTS` is not accepted by this SQLite build, so
          // a forward file spells a column add as `ADD COLUMN`. Skip it when
          // the column is already there: a fresh baseline has it, an older
          // file does not.
          const addColumn = /^ALTER TABLE "(\w+)" ADD COLUMN "(\w+)" /i.exec(sql);
          if (addColumn) {
            const table = addColumn[1];
            const column = addColumn[2];
            const present = column === undefined
              ? null
              : sqlite
                  .prepare(`SELECT 1 AS present FROM pragma_table_info('${table}') WHERE name = ?`)
                  .get(column) as { present: number } | null;
            if (present !== null) continue;
          }
          sqlite.exec(sql);
        }
        record.run(migrationId);
      })();
      applied.add(migrationId);
    } catch (error) {
      throw new Error(`Migration ${migrationId} failed: ${String(error)}`, { cause: error });
    }
  }
}
