/// <reference types="bun-types" />
/**
 * bun:sqlite connection pool for runtime logging.
 *
 * bun:sqlite is synchronous; "pooling" is implemented by acquiring a
 * dedicated handle, running one or more statements, and releasing it. This
 * keeps writes off the hot path of the event loop and gives a single
 * place to enforce WAL mode, synchronous=OFF, prepared-statement cache,
 * and auto-vacuum policies.
 *
 * The module is intentionally Bun-only — it must not be loaded by the
 * SolidJS frontend bundle.
 */

import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite'
import { isLogLevel, LOG_LEVEL_PRIORITY, type LogLevel } from './log-level'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Log severity tiers accepted by the writer — see `./log-level`. */
export type { LogLevel }

/** Row shape stored in the `logs` table. */
export interface LogRow {
  id: number
  timestamp: number
  level: LogLevel
  provider: string | null
  request_id: string | null
  message: string
  context: string | null
}

/** Row shape accepted by the writer (no id; DB-assigned). */
export interface LogInsert {
  timestamp?: number
  level: LogLevel
  provider?: string | null
  request_id?: string | null
  message: string
  context?: string | null
}

/** Insert/update outcome, mirroring bun:sqlite's `Changes` shape. */
export interface SqliteChanges {
  changes: number
  lastInsertRowid: number | bigint
}

/** Configuration consumed by `createSqliteLogPool`. */
export interface SqliteLogOptions {
  /** Database file path, or `:memory:` for ephemeral (default `data/logs.db`). */
  filename?: string
  /** Maximum concurrent connections (default 10). */
  max?: number
  /** Set synchronous=OFF; recommended for durability-vs-throughput (default true). */
  synchronousOff?: boolean
  /** Enable WAL journal mode (default true). */
  wal?: boolean
  /** Auto-vacuum logs older than this many milliseconds (default 7 days). */
  vacuumAfterMs?: number
  /** Hard cap on rows the reader returns per query (default 5_000). */
  maxResultRows?: number
  /** Vacuum checkpoint interval in ms (default 60s). */
  checkpointIntervalMs?: number
  /** Logger for vacuum/error reports. */
  logger?: SqliteLogger
}

export interface SqliteLogger {
  info: (message: string, context?: Record<string, unknown>) => void
  warn: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, context?: Record<string, unknown>) => void
}

/** Connection handle leased from the pool. */
export interface SqliteLogConnection {
  /** Underlying database handle — use sparingly. */
  readonly db: Database
  /** Acquired at time — useful for leak detection. */
  readonly acquiredAt: number
  /** Resolve a cached prepared statement for this connection. */
  prepare: <Result = unknown, ParamsType extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ) => Statement<Result, ParamsType>
  /** Release the connection back to the pool. Idempotent. */
  release: () => void
}

/** Pool statistics. */
export interface SqliteLogStats {
  /** Connections currently in use. */
  inUse: number
  /** Connections idle in the pool. */
  idle: number
  /** Total leases ever handed out. */
  acquireCount: number
  /** Total returns ever observed. */
  releaseCount: number
  /** Total prepared-statement hits (resolved from cache). */
  statementHitCount: number
  /** Total prepared-statement misses (had to compile). */
  statementMissCount: number
  /** Total log inserts performed. */
  insertCount: number
  /** Total vacuum operations executed. */
  vacuumCount: number
  /** Resident set size of the process in bytes. */
  residentMemoryBytes: number
  /** Configured max connections. */
  max: number
  /** Path of the underlying database. */
  filename: string
  /** Last vacuum timestamp (ms since epoch) or null. */
  lastVacuumAt: number | null
  /** Last vacuum duration in ms. */
  lastVacuumDurationMs: number
}

/** Callback handed to `withConnection`/`withConnectionSync`. */
export type SqliteLogHandler<R> = (conn: SqliteLogConnection) => R | Promise<R>

/** Public handle returned by `createSqliteLogPool`. */
export interface SqliteLogHandle {
  readonly options: Required<SqliteLogOptions>
  readonly logger: SqliteLogger
  /** Acquire a connection; release it after use to prevent leaks. */
  acquire: () => Promise<SqliteLogConnection>
  /** Run `fn` inside a lease that auto-releases on completion. */
  withConnection: <R>(fn: SqliteLogHandler<R>) => Promise<R>
  /** Synchronous variant of `withConnection` — for code already on the event loop. */
  withConnectionSync: <R>(fn: SqliteLogHandler<R>) => R
  /** Insert a log row. */
  insertLog: (entry: LogInsert) => SqliteChanges
  /** Read recent log rows, newest first, capped by `maxResultRows`. */
  readLogs: (limit?: number, levelAtLeast?: LogLevel) => LogRow[]
  /** Force a vacuum right now; returns rows deleted. */
  vacuumNow: () => Promise<{ deletedRows: number; durationMs: number }>
  /** Force a WAL checkpoint right now. */
  checkpoint: (mode?: 'off' | 'truncate' | 'full' | 'passive') => void
  /** Pool stats snapshot. */
  stats: () => SqliteLogStats
  /** Close every connection and prepare-shutdown the pool. */
  close: () => void
  /** Get the latest resident memory footprint. */
  memoryBytes: () => number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  filename: 'data/logs.db',
  max: 10,
  synchronousOff: true,
  wal: true,
  vacuumAfterMs: 7 * 24 * 60 * 60 * 1000,
  maxResultRows: 5_000,
  checkpointIntervalMs: 60_000,
} as const satisfies Required<
  Pick<
    SqliteLogOptions,
    'filename' | 'max' | 'synchronousOff' | 'wal' | 'vacuumAfterMs' | 'maxResultRows' | 'checkpointIntervalMs'
  >
>

const DEFAULT_LOGGER: SqliteLogger = {
  info: (message, context): void => {
    // eslint-disable-next-line no-console
    console.log(`[sqlite:info] ${message}`, context ?? {})
  },
  warn: (message, context): void => {
    // eslint-disable-next-line no-console
    console.warn(`[sqlite:warn] ${message}`, context ?? {})
  },
  error: (message, context): void => {
    // eslint-disable-next-line no-console
    console.error(`[sqlite:error] ${message}`, context ?? {})
  },
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** DDL that creates the `logs` table and supporting indexes. */
export const LOGS_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('trace','debug','info','warn','error','fatal')),
  provider TEXT,
  request_id TEXT,
  message TEXT NOT NULL,
  context TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_provider ON logs(provider);
CREATE INDEX IF NOT EXISTS idx_logs_request_id ON logs(request_id);
CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs(level, timestamp DESC);
` as const

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface PoolEntry {
  db: Database
  statementCache: Map<string, Statement<unknown, SQLQueryBindings[]>>
  leasedAt: number | null
}

interface PoolTelemetry {
  acquireCount: number
  releaseCount: number
  statementHitCount: number
  statementMissCount: number
  insertCount: number
  vacuumCount: number
  lastVacuumAt: number | null
  lastVacuumDurationMs: number
  checkpointTimer: ReturnType<typeof setInterval> | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read process resident set size (RSS) in bytes — Bun/Node only. */
export function readResidentMemory(): number {
  return process.memoryUsage?.().rss ?? 0
}

function createPoolEntry(filename: string, synchronousOff: boolean, wal: boolean): PoolEntry {
  const db = new Database(filename, { create: true })
  // Pragmas — applied in the order recommended by sqlite.org. bun:sqlite has
  // no `.pragma()` helper; PRAGMA statements run through `.run()`.
  db.run('PRAGMA journal_mode = WAL;')
  db.run('PRAGMA synchronous = NORMAL;')
  if (synchronousOff) {
    // Caller asked for synchronous=OFF explicitly. NORMAL is the safe default
    // above; OFF is only applied when explicitly requested.
    db.run('PRAGMA synchronous = OFF;')
  }
  db.run('PRAGMA foreign_keys = ON;')
  db.run('PRAGMA temp_store = MEMORY;')
  db.run('PRAGMA cache_size = -20000;') // ~20 MiB
  // Apply schema immediately so the first acquire sees the tables.
  db.run(LOGS_SCHEMA_DDL)
  if (!wal) {
    db.run('PRAGMA journal_mode = DELETE;')
  }
  return { db, statementCache: new Map(), leasedAt: null }
}

function wrapEntry(entry: PoolEntry, telemetry: PoolTelemetry, idle: PoolEntry[], leased: PoolEntry[]): SqliteLogConnection {
  return {
    db: entry.db,
    acquiredAt: entry.leasedAt ?? Date.now(),
    prepare<Result = unknown, ParamsType extends SQLQueryBindings[] = SQLQueryBindings[]>(
      sql: string,
    ): Statement<Result, ParamsType> {
      const cached = entry.statementCache.get(sql)
      if (cached) {
        telemetry.statementHitCount += 1
        return cached as unknown as Statement<Result, ParamsType>
      }
      telemetry.statementMissCount += 1
      // bun:sqlite's `prepare` return type is `ParamsType extends any[] ? ParamsType : [ParamsType]`,
      // which TS cannot simplify back to `ParamsType` for an unresolved generic — cast through the
      // runtime-equivalent shape (ParamsType already extends SQLQueryBindings[] here).
      const stmt = entry.db.prepare<Result, ParamsType>(sql) as unknown as Statement<Result, ParamsType>
      entry.statementCache.set(sql, stmt as unknown as Statement<unknown, SQLQueryBindings[]>)
      return stmt
    },
    release(): void {
      const idx = leased.indexOf(entry)
      if (idx === -1) return
      leased.splice(idx, 1)
      entry.leasedAt = null
      idle.push(entry)
      telemetry.releaseCount += 1
    },
  }
}

// ---------------------------------------------------------------------------
// Pool factory
// ---------------------------------------------------------------------------

/** Build a configured bun:sqlite pool with WAL mode and rotation. */
export function createSqliteLogPool(options: SqliteLogOptions = {}): SqliteLogHandle {
  const logger = options.logger ?? DEFAULT_LOGGER
  const merged: SqliteLogHandle['options'] = {
    filename: options.filename ?? DEFAULT_OPTIONS.filename,
    max: options.max ?? DEFAULT_OPTIONS.max,
    synchronousOff: options.synchronousOff ?? DEFAULT_OPTIONS.synchronousOff,
    wal: options.wal ?? DEFAULT_OPTIONS.wal,
    vacuumAfterMs: options.vacuumAfterMs ?? DEFAULT_OPTIONS.vacuumAfterMs,
    maxResultRows: options.maxResultRows ?? DEFAULT_OPTIONS.maxResultRows,
    checkpointIntervalMs: options.checkpointIntervalMs ?? DEFAULT_OPTIONS.checkpointIntervalMs,
    logger,
  }

  const idle: PoolEntry[] = []
  const leased: PoolEntry[] = []
  const telemetry: PoolTelemetry = {
    acquireCount: 0,
    releaseCount: 0,
    statementHitCount: 0,
    statementMissCount: 0,
    insertCount: 0,
    vacuumCount: 0,
    lastVacuumAt: null,
    lastVacuumDurationMs: 0,
    checkpointTimer: null,
  }

  function spawnEntry(): PoolEntry {
    return createPoolEntry(merged.filename, merged.synchronousOff, merged.wal)
  }

  function leaseOne(): SqliteLogConnection {
    telemetry.acquireCount += 1
    let entry = idle.pop() ?? null
    if (!entry && leased.length < merged.max) {
      entry = spawnEntry()
    }
    if (!entry) {
      throw new Error('sqlite pool exhausted; release a connection before acquiring')
    }
    entry.leasedAt = Date.now()
    leased.push(entry)
    return wrapEntry(entry, telemetry, idle, leased)
  }

  async function acquire(): Promise<SqliteLogConnection> {
    return leaseOne()
  }

  async function withConnection<R>(fn: SqliteLogHandler<R>): Promise<R> {
    const conn = leaseOne()
    try {
      return await fn(conn)
    } finally {
      conn.release()
    }
  }

  function withConnectionSync<R>(fn: SqliteLogHandler<R>): R {
    const conn = leaseOne()
    try {
      // Sync lease contract: fn must not return a Promise here.
      return fn(conn) as R
    } finally {
      conn.release()
    }
  }

  function insertLog(entry: LogInsert): SqliteChanges {
    return withConnectionSync((conn) => {
      const stmt = conn.prepare<SqliteChanges, [number, LogLevel, string | null, string | null, string, string | null]>(
        `INSERT INTO logs (timestamp, level, provider, request_id, message, context)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      telemetry.insertCount += 1
      return stmt.run(
        entry.timestamp ?? Date.now(),
        entry.level,
        entry.provider ?? null,
        entry.request_id ?? null,
        entry.message,
        entry.context ?? null,
      )
    })
  }

  function readLogs(limit?: number, levelAtLeast?: LogLevel): LogRow[] {
    const cap = Math.min(limit ?? merged.maxResultRows, merged.maxResultRows)
    const minPriority = levelAtLeast ? LOG_LEVEL_PRIORITY[levelAtLeast] : 0
    return withConnectionSync((conn) => {
      const stmt = conn.prepare<LogRow, [number]>(
        `SELECT id, timestamp, level, provider, request_id, message, context
         FROM logs
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      const rows = stmt.all(cap)
      return minPriority > 0 ? rows.filter((row) => LOG_LEVEL_PRIORITY[row.level] >= minPriority) : rows
    })
  }

  async function vacuumNow(): Promise<{ deletedRows: number; durationMs: number }> {
    return withConnection((conn) => {
      const start = Date.now()
      const threshold = start - merged.vacuumAfterMs
      const beforeRow = conn.db
        .prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM logs')
        .get()
      const result = conn.db.prepare<SqliteChanges, [number]>('DELETE FROM logs WHERE timestamp < ?').run(threshold) as unknown as SqliteChanges
      conn.db.run('PRAGMA wal_checkpoint(TRUNCATE);')
      const duration = Date.now() - start
      telemetry.vacuumCount += 1
      telemetry.lastVacuumAt = start
      telemetry.lastVacuumDurationMs = duration
      logger.info('sqlite vacuum complete', {
        deletedRows: result.changes,
        beforeCount: beforeRow?.n ?? 0,
        durationMs: duration,
      })
      return { deletedRows: result.changes, durationMs: duration }
    })
  }

  function checkpoint(mode: 'off' | 'truncate' | 'full' | 'passive' = 'passive'): void {
    withConnectionSync((conn) => {
      conn.db.run(`PRAGMA wal_checkpoint(${mode.toUpperCase()});`)
    })
  }

  function stats(): SqliteLogStats {
    return {
      inUse: leased.length,
      idle: idle.length,
      acquireCount: telemetry.acquireCount,
      releaseCount: telemetry.releaseCount,
      statementHitCount: telemetry.statementHitCount,
      statementMissCount: telemetry.statementMissCount,
      insertCount: telemetry.insertCount,
      vacuumCount: telemetry.vacuumCount,
      residentMemoryBytes: readResidentMemory(),
      max: merged.max,
      filename: merged.filename,
      lastVacuumAt: telemetry.lastVacuumAt,
      lastVacuumDurationMs: telemetry.lastVacuumDurationMs,
    }
  }

  function close(): void {
    if (telemetry.checkpointTimer) {
      clearInterval(telemetry.checkpointTimer)
      telemetry.checkpointTimer = null
    }
    for (const entry of [...idle, ...leased]) {
      try {
        entry.db.close()
      } catch (err) {
        logger.error('error closing sqlite handle', { message: (err as Error).message })
      }
    }
    idle.length = 0
    leased.length = 0
  }

  function memoryBytes(): number {
    return readResidentMemory()
  }

  // Periodic rotation/vacuum.
  telemetry.checkpointTimer = setInterval(() => {
    void vacuumNow().catch((err: Error) => {
      logger.error('periodic vacuum failed', { message: err.message })
    })
  }, Math.max(merged.checkpointIntervalMs, 1_000))
  // Don't keep the process alive solely for vacuum.
  if (typeof telemetry.checkpointTimer.unref === 'function') {
    telemetry.checkpointTimer.unref()
  }

  return {
    options: merged,
    logger,
    acquire,
    withConnection,
    withConnectionSync,
    insertLog,
    readLogs,
    vacuumNow,
    checkpoint,
    stats,
    close,
    memoryBytes,
  }
}

// ---------------------------------------------------------------------------
// Singleton convenience
// ---------------------------------------------------------------------------

let singleton: SqliteLogHandle | null = null

/** Get or lazily create a process-wide sqlite log pool. */
export function getSqliteLogPool(options: SqliteLogOptions = {}): SqliteLogHandle {
  if (singleton) return singleton
  singleton = createSqliteLogPool(options)
  return singleton
}

/** Close the singleton pool. */
export function closeSqliteLogPool(): void {
  if (!singleton) return
  singleton.close()
  singleton = null
}

/** Reset singleton state without closing (test-only). */
export function __resetSqliteLogForTests(): void {
  singleton = null
}

// Re-export raw types for callers that need them.
export type { Database, Statement }
export { isLogLevel, LOG_LEVEL_PRIORITY }
