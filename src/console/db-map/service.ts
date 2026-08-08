/**
 * Database Map service — schema introspection, bounded row reads, SQL
 * query/execute, and raw .sqlite export/import for both the configuration
 * and runtime telemetry databases.
 *
 * Boundary note (this is a deliberately separate admin tool):
 * - db-map is a database browser + SQL console behind the console session
 *   guard. It is NOT a request hot path, so it does not route through the
 *   configuration/runtime repository boundaries — those cannot express
 *   arbitrary schema introspection or ad-hoc DML/DDL.
 * - Read operations (schema, rows, query) open their own read-only
 *   `Database` connections. A read-only connection never contends with the
 *   singletons' WAL state, so browsing stays cheap and isolated.
 * - Write operations (`execute`) go through the singleton persistence's live
 *   `Database` handle (see {@link DbMapPersistence}) so writes land in the
 *   same WAL session the rest of the process uses, instead of opening a
 *   competing read-write connection that can desync the singleton's view.
 * - Import (`importDb`) checkpoints and reopens the singleton after the file
 *   swap so no repository is left pinned to a stale inode.
 *
 * Security:
 * - Read operations (schema, rows, query) use read-only connections.
 * - Write operations (execute) use the singleton's read-write handle with
 *   busy_timeout, wrapped in a transaction for atomicity.
 * - Table names are validated against `sqlite_master` before interpolation —
 *   never raw user input in a SQL string.
 * - Sensitive columns are masked in row output.
 * - Query mode rejects non-SELECT statements; execute mode rejects
 *   PRAGMA/ATTACH/VACUUM and other persistence-altering commands.
 */

import { Database } from "bun:sqlite";
import { existsSync, renameSync, unlinkSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPersistenceEnv, type PersistenceEnv } from "../../storage/main/env";
import { sanitizeMessage } from "../../application/contracts";
import {
  isSensitiveColumn,
  type ColumnInfo,
  type DbTarget,
  type ExecuteResult,
  type ExportResult,
  type ImportResult,
  type IndexInfo,
  type QueryResult,
  type SchemaResult,
  type TableInfo,
  type TableRowsResult,
} from "./types";

/**
 * Optional coordination hooks into the application persistence singletons.
 *
 * db-map is a deliberately separate admin tool (database browser + SQL
 * console) with its own connection lifecycle — its read paths open their own
 * read-only `Database` connections because a read-only connection never
 * contends with the singletons' WAL state and lets browsing stay cheap and
 * isolated. Write operations and database import, however, must coordinate
 * with the live singletons:
 *
 * - `db(target)` returns the singleton's open `Database` so `execute` (DML/DDL)
 *   writes through the same WAL session the rest of the process uses, instead
 *   of opening a competing read-write connection that can desync the
 *   singleton's view and corrupt its checkpoint cadence.
 * - `closeForSwap(target)` checkpoints and closes the singleton's handle so
 *   the live file can be renamed/overwritten (Windows refuses to replace a
 *   file held open by another handle; POSIX would leave the singleton pinned
 *   to a stale inode). Unlike the terminal shutdown `close()`, a swapped-out
 *   singleton can be brought back with `reopen`.
 * - `reopen(target)` opens a fresh connection at the same path so an imported
 *   database is picked up by every repository.
 *
 * When omitted (tests, standalone tooling) the service falls back to opening
 * its own read-write connection for `execute` and skips the swap coordination
 * after import — the same behavior as before this coordination was added.
 */
export interface DbMapPersistence {
  /** Live singleton `Database` for coordinated writes, or null if none is open. */
  readonly db: (target: DbTarget) => Database | null;
  /** Checkpoint + close the singleton handle so the live file can be swapped. */
  readonly closeForSwap: (target: DbTarget) => void;
  /** Reopen the singleton against the (possibly swapped) file at the same path. */
  readonly reopen: (target: DbTarget) => void;
}

const MASK_VALUE = "••••••";

/** Maximum rows returned by table-rows or query endpoints. */
const MAX_ROWS = 1000;

/** Default row limit for table-rows endpoint. */
const DEFAULT_ROW_LIMIT = 100;

/** Maximum accepted import file size (64 MiB — same as backup). */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** SQLite magic header bytes: "SQLite format 3\0". */
const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

/** Table name validation — only alphanumeric + underscore, starting with letter/underscore. */
const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * SQL keywords that are always forbidden (both query and execute modes).
 * These alter persistence, attach external databases, or escape the sandbox.
 */
const FORBIDDEN_KEYWORDS: Record<string, true> = {
  pragma: true,
  attach: true,
  detach: true,
  vacuum: true,
  reindex: true,
  analyze: true,
  load: true,
  savepoint: true,
  release: true,
};

/**
 * SQL statement types allowed in query mode (read-only). Everything else is
 * rejected — no INSERT/UPDATE/DELETE/DDL in query mode.
 */
const QUERY_ALLOWED_VERBS: Record<string, true> = {
  select: true,
  with: true,
  explain: true,
  values: true,
};

/**
 * SQL statement types allowed in execute mode (DML + DDL). PRAGMA/ATTACH/
 * VACUUM are still forbidden.
 */
const EXECUTE_ALLOWED_VERBS: Record<string, true> = {
  insert: true,
  update: true,
  delete: true,
  create: true,
  drop: true,
  alter: true,
  begin: true,
  commit: true,
  rollback: true,
};

// ---------------------------------------------------------------------------
// Raw row types (internal)
// ---------------------------------------------------------------------------

interface TableRow {
  name: string;
  sql?: string;
}

interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface PragmaIndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface PragmaIndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface CountRow {
  cnt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskRow(row: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    masked[key] = isSensitiveColumn(key) && value !== null ? MASK_VALUE : value;
  }
  return masked;
}

function extractVerb(sql: string): string {
  const trimmed = sql.trim().toLowerCase();
  // Skip leading EXPLAIN and WITH ... AS (...) clauses to find the real verb
  const verbMatch = trimmed.match(/^(?:explain\s+)?(select|with|insert|update|delete|create|drop|alter|pragma|attach|detach|vacuum|reindex|analyze|load|savepoint|release|begin|commit|rollback|values)/);
  return verbMatch?.[1] ?? "";
}

function hasForbiddenKeyword(sql: string): string | null {
  const lower = sql.toLowerCase();
  // Tokenize roughly — word boundary check to avoid matching substrings
  for (const kw of Object.keys(FORBIDDEN_KEYWORDS)) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(lower)) return kw;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DbMapService {
  private readonly env: PersistenceEnv;
  private readonly persistence: DbMapPersistence | null;

  constructor(env: PersistenceEnv = getPersistenceEnv(), persistence: DbMapPersistence | null = null) {
    this.env = env;
    this.persistence = persistence;
  }

  private pathFor(target: DbTarget): string {
    return target === "config" ? this.env.dbPath : this.env.runtimeDbPath;
  }

  /** Opens a read-only connection — never creates the file. */
  private openReadonly(target: DbTarget): Database {
    const path = this.pathFor(target);
    if (!existsSync(path)) throw new Error(`${target} database not found`);
    const db = new Database(path, { readonly: true, create: false });
    db.exec("PRAGMA busy_timeout=3000");
    return db;
  }

  /**
   * Resolves a write-capable `Database` for `target`. Prefers the singleton
   * persistence handle (coordinated WAL session); falls back to opening a
   * standalone read-write connection when no singleton is wired in (tests,
   * standalone tooling). The standalone connection is closed by the caller.
   */
  private openForWrite(target: DbTarget): { db: Database; owned: boolean } {
    const singleton = this.persistence?.db(target) ?? null;
    if (singleton !== null) {
      return { db: singleton, owned: false };
    }
    const path = this.pathFor(target);
    if (!existsSync(path)) throw new Error(`${target} database not found`);
    const db = new Database(path, { readonly: false, create: false });
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    return { db, owned: true };
  }

  // ── Schema introspection ──────────────────────────────────────────────

  getSchema(target: DbTarget): SchemaResult {
    const db = this.openReadonly(target);
    try {
      const tableRows = db
        .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as TableRow[];

      const tables: TableInfo[] = tableRows.map((row) => {
        const name = row.name;
        if (!TABLE_NAME_RE.test(name)) {
          return { name, rowCount: 0, columns: [], indexes: [] };
        }

        // Column info via PRAGMA table_info — safe because name is validated
        const colRows = db
          .query(`PRAGMA table_info(${name})`)
          .all() as PragmaTableInfoRow[];
        const columns: ColumnInfo[] = colRows.map((c) => ({
          name: c.name,
          type: c.type,
          notNull: c.notnull === 1,
          defaultValue: c.dflt_value,
          pk: c.pk > 0,
          sensitive: isSensitiveColumn(c.name),
        }));

        // Index info
        const idxRows = db
          .query(`PRAGMA index_list(${name})`)
          .all() as PragmaIndexListRow[];
        const indexes: IndexInfo[] = idxRows.map((idx) => {
          const colRows = db
            .query(`PRAGMA index_info(${idx.name})`)
            .all() as PragmaIndexInfoRow[];
          return {
            name: idx.name,
            unique: idx.unique === 1,
            columns: colRows.map((r) => r.name),
          };
        });

        // Row count — SELECT count(*) is safe on validated table name
        const countRow = db
          .query(`SELECT count(*) AS cnt FROM ${name}`)
          .get() as CountRow | null;
        const rowCount = countRow?.cnt ?? 0;

        return { name, rowCount, columns, indexes };
      });

      return { database: target, tables };
    } finally {
      db.close();
    }
  }

  // ── Table rows (paginated, read-only) ──────────────────────────────────

  getTableRows(target: DbTarget, table: string, limit: number, offset: number): TableRowsResult {
    if (!TABLE_NAME_RE.test(table)) {
      throw new Error("invalid table name");
    }

    const db = this.openReadonly(target);
    try {
      // Verify the table exists in sqlite_master
      const exists = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as TableRow | null;
      if (!exists) throw new Error(`table "${table}" not found`);

      const safeLimit = Math.max(1, Math.min(limit || DEFAULT_ROW_LIMIT, MAX_ROWS));
      const safeOffset = Math.max(0, offset);

      const rawRows = db
        .query(`SELECT * FROM ${table} LIMIT ? OFFSET ?`)
        .all(safeLimit, safeOffset) as Record<string, unknown>[];
      const rows = rawRows.map(maskRow);

      const countRow = db
        .query(`SELECT count(*) AS cnt FROM ${table}`)
        .get() as CountRow | null;
      const total = countRow?.cnt ?? 0;

      const columns: string[] = rows.length > 0
        ? Object.keys(rows[0]!)
        : (db
            .query(`PRAGMA table_info(${table})`)
            .all() as PragmaTableInfoRow[])
            .map((c) => c.name);

      return { table, columns, rows, total, limit: safeLimit, offset: safeOffset };
    } finally {
      db.close();
    }
  }

  // ── SQL query (SELECT only) ───────────────────────────────────────────

  query(target: DbTarget, sql: string): QueryResult {
    const verb = extractVerb(sql);
    if (!QUERY_ALLOWED_VERBS[verb]) {
      throw new Error(`query mode allows only SELECT/WITH/EXPLAIN — found: ${verb || "unknown"}`);
    }
    const forbidden = hasForbiddenKeyword(sql);
    if (forbidden) {
      throw new Error(`forbidden keyword in query: ${forbidden}`);
    }

    const db = this.openReadonly(target);
    try {
      const started = Date.now();
      const stmt = db.prepare(sql);
      const rawRows = stmt.all() as Record<string, unknown>[];
      const rows = rawRows.map(maskRow);
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      const durationMs = Date.now() - started;

      const cappedRows = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;

      return {
        columns,
        rows: cappedRows,
        changes: 0,
        durationMs,
      };
    } finally {
      db.close();
    }
  }

  // ── SQL execute (DML + DDL) ────────────────────────────────────────────

  execute(target: DbTarget, sql: string): ExecuteResult {
    const verb = extractVerb(sql);
    if (!EXECUTE_ALLOWED_VERBS[verb]) {
      throw new Error(`execute mode allows only INSERT/UPDATE/DELETE/CREATE/DROP/ALTER — found: ${verb || "unknown"}`);
    }
    const forbidden = hasForbiddenKeyword(sql);
    if (forbidden) {
      throw new Error(`forbidden keyword in execute: ${forbidden}`);
    }

    const { db, owned } = this.openForWrite(target);
    try {
      const started = Date.now();
      // Wrap in a transaction for atomicity. When writing through the
      // singleton handle this is still safe — db-map is an admin tool behind
      // the session guard and does not run concurrently with request-path
      // config writes (which use short-lived transactions on the same handle).
      db.exec("BEGIN");
      try {
        const stmt = db.prepare(sql);
        const result = stmt.run();
        db.exec("COMMIT");
        return {
          changes: result.changes,
          lastInsertRowId: typeof result.lastInsertRowid === "bigint" ? Number(result.lastInsertRowid) : result.lastInsertRowid ?? null,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* best-effort */ }
        throw err;
      }
    } finally {
      // Only close connections this service opened. The singleton handle
      // outlives this call and is managed by the persistence lifecycle.
      if (owned) db.close();
    }
  }

  // ── Export (raw .sqlite download) ──────────────────────────────────────

  exportDb(target: DbTarget): ExportResult {
    const path = this.pathFor(target);
    if (!existsSync(path)) return { ok: false, error: `${target} database not found` };

    // Checkpoint WAL to the main file so the snapshot is consistent
    try {
      const db = this.openReadonly(target);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    } catch {
      // Best-effort — the file read below will still work
    }

    try {
      const data = readFileSync(path);
      const filename = `${target === "config" ? "cartethyia" : "runtime"}-${new Date().toISOString().slice(0, 10)}.sqlite`;
      return { ok: true, filename, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    } catch (error) {
      return { ok: false, error: sanitizeMessage(error instanceof Error ? error.message : "export failed") };
    }
  }

  // ── Import (validate + replace .sqlite file) ──────────────────────────

  importDb(target: DbTarget, data: Uint8Array): ImportResult {
    if (data.byteLength > MAX_IMPORT_BYTES) {
      return { ok: false, error: `import file exceeds ${MAX_IMPORT_BYTES} bytes` };
    }

    // Validate SQLite magic header
    if (data.byteLength < SQLITE_MAGIC.length) {
      return { ok: false, error: "file is too small to be a valid SQLite database" };
    }
    for (let i = 0; i < SQLITE_MAGIC.length; i++) {
      if (data[i] !== SQLITE_MAGIC[i]) {
        return { ok: false, error: "file is not a valid SQLite database (magic header mismatch)" };
      }
    }

    // Write to a temp file and validate it opens
    const tempPath = join(tmpdir(), `cartethyia-import-${target}-${process.pid}-${Date.now()}.sqlite`);
    try {
      writeFileSync(tempPath, data);

      // Validate: open read-only and check it has tables
      let validateDb: Database;
      try {
        validateDb = new Database(tempPath, { readonly: true, create: false });
      } catch {
        return { ok: false, error: "file could not be opened as a SQLite database" };
      }

      try {
        const tables = validateDb
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as TableRow[];
        if (tables.length === 0) {
          return { ok: false, error: "database contains no tables" };
        }
      } finally {
        validateDb.close();
      }

      // Replace the live database file
      const livePath = this.pathFor(target);
      const backupPath = `${livePath}.bak-${Date.now()}`;

      // Coordinate with the live singleton: checkpoint + close its handle so
      // the live file can be renamed/overwritten. On Windows a file held open
      // by another handle cannot be replaced; on POSIX the rename would
      // succeed but leave the singleton pinned to a stale inode, risking WAL
      // corruption on its next write. We reopen the singleton against the new
      // file after the swap completes.
      this.persistence?.closeForSwap(target);

      // Backup the current file
      if (existsSync(livePath)) {
        try {
          copyFileSync(livePath, backupPath);
        } catch (error) {
          this.persistence?.reopen(target);
          return { ok: false, error: `failed to backup current database: ${sanitizeMessage(error instanceof Error ? error.message : "unknown")}` };
        }
      }

      // Close any WAL/SHM sidecars by renaming them aside
      const walPath = `${livePath}-wal`;
      const shmPath = `${livePath}-shm`;
      const walBak = `${backupPath}-wal`;
      const shmBak = `${backupPath}-shm`;
      try {
        if (existsSync(walPath)) renameSync(walPath, walBak);
        if (existsSync(shmPath)) renameSync(shmPath, shmBak);
      } catch {
        // best-effort
      }

      // Move the new file into place
      let swapped = false;
      try {
        renameSync(tempPath, livePath);
        swapped = true;
      } catch {
        // On Windows, rename across volumes fails — fall back to copy + delete
        try {
          const buf = readFileSync(tempPath);
          writeFileSync(livePath, buf);
          unlinkSync(tempPath);
          swapped = true;
        } catch (error) {
          // Restore backup if copy failed
          if (existsSync(backupPath)) renameSync(backupPath, livePath);
          this.persistence?.reopen(target);
          return { ok: false, error: `failed to write database: ${sanitizeMessage(error instanceof Error ? error.message : "unknown")}` };
        }
      }

      // Clean up WAL/SHM backups — the new DB will create fresh ones
      try {
        if (existsSync(walBak)) unlinkSync(walBak);
        if (existsSync(shmBak)) unlinkSync(shmBak);
      } catch {
        // best-effort
      }

      // Reopen the singleton against the new file so every repository sees
      // the imported database. `reopen` re-runs schema/migration, so an
      // imported DB lacking our tables is brought up to date.
      if (swapped) {
        try {
          this.persistence?.reopen(target);
        } catch (error) {
          // The file swap succeeded; a reopen failure is non-fatal — the
          // next access reopens lazily. Surface it so the operator knows.
          return {
            ok: true,
            message: `${target} database imported successfully, but the live connection could not be reopened immediately: ${sanitizeMessage(error instanceof Error ? error.message : "unknown")}. It will reopen on the next access.`,
          };
        }
      }

      return {
        ok: true,
        message: `${target} database imported successfully. The live connection has been reopened against the new file.`,
      };
    } catch (error) {
      // Clean up temp file on any unexpected error
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {
        // ignore
      }
      return { ok: false, error: sanitizeMessage(error instanceof Error ? error.message : "import failed") };
    }
  }
}
