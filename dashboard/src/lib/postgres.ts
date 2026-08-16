/**
 * PostgreSQL connection pool for the Cartethyia dashboard.
 *
 * Centralises connection acquisition so callers always release clients back
 * into the pool. The pool is bounded (default 20 connections) and the module
 * tracks acquire/release counters plus per-client idle durations so memory
 * leaks are observable, not silent.
 *
 * The module is intentionally Node-only — it must not be loaded by the
 * SolidJS frontend bundle.
 */

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Logger contract — any object with `info`, `warn`, `error` methods. */
export interface PgLogger {
  info: (message: string, context?: Record<string, unknown>) => void
  warn: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, context?: Record<string, unknown>) => void
}

/** Configuration consumed by `createPgPool`. */
export interface PgPoolOptions {
  /** Connection string OR individual fields. */
  connectionString?: string
  user?: string
  password?: string
  host?: string
  port?: number
  database?: string
  /** Maximum connections (default 20). */
  max?: number
  /** Minimum idle connections kept warm (default 2). */
  min?: number
  /** Connection acquire timeout in ms (default 5000). */
  connectionTimeoutMillis?: number
  /** Idle connection close timeout in ms (default 30000). */
  idleTimeoutMillis?: number
  /** Server-side statement_timeout in ms (default 15000). */
  statementTimeoutMillis?: number
  /** Server-side query_timeout in ms (default 30000). */
  queryTimeoutMillis?: number
  /** SSL mode toggle. */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string }
  /** Application name surfaced in `pg_stat_activity` (default 'cartethyia-dashboard'). */
  applicationName?: string
  /** Maximum retries for transient errors (default 3). */
  maxRetries?: number
  /** Base backoff between retries in ms (default 250). */
  retryBackoffMillis?: number
  /** Hard cap on result rows returned by helpers (default 10_000). */
  maxResultRows?: number
  /** Inject a logger; falls back to console. */
  logger?: PgLogger
}

interface PoolLikeStats {
  totalCount: number
  idleCount: number
  waitingCount: number
}

/** Pool statistics snapshot. */
export interface PgPoolStats extends PoolLikeStats {
  /** Total `client.query` calls executed since startup. */
  queryCount: number
  /** Total acquire attempts since startup. */
  acquireCount: number
  /** Number of queries that retried at least once. */
  retryCount: number
  /** Number of queries that failed permanently. */
  errorCount: number
  /** Number of `PoolClient.release()` calls observed. */
  releaseCount: number
  /** Pool configured max connections. */
  max: number
  /** Approximate resident memory in bytes (process.rss()). */
  residentMemoryBytes: number
}

/** Options accepted by `query`/`withTransaction` helpers. */
export interface QueryHelperOptions {
  /** Soft cap on rows; the helper throws if the result exceeds it. */
  maxResultRows?: number
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal
  /** Attach a name (useful for pg logs / pg_stat_statements). */
  name?: string
}

/** Transactional handler invoked with a checked-out client. */
export type PgTransactionHandler<R> = (client: PoolClient) => Promise<R>

/** Public handle returned by `createPgPool`. */
export interface PgPoolHandle {
  /** Underlying `pg.Pool` (escape hatch — callers may still wrap with `withClient`). */
  readonly pool: Pool
  /** Resolved options. */
  readonly options: Required<
    Pick<
      PgPoolOptions,
      | 'max'
      | 'min'
      | 'connectionTimeoutMillis'
      | 'idleTimeoutMillis'
      | 'statementTimeoutMillis'
      | 'queryTimeoutMillis'
      | 'applicationName'
      | 'maxRetries'
      | 'retryBackoffMillis'
      | 'maxResultRows'
    >
  >
  /** Logger used by the pool. */
  readonly logger: PgLogger
  /** Run a single query with retry, timeout, and result-set guards. */
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
    options?: QueryHelperOptions,
  ) => Promise<QueryResult<R>>
  /** Run `handler` inside a transaction; commits on success, rolls back on throw. */
  withTransaction: <R>(handler: PgTransactionHandler<R>) => Promise<R>
  /** Close the pool; rejects new acquires. */
  close: () => Promise<void>
  /** Snapshot of pool counters and memory. */
  stats: () => PgPoolStats
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  max: 20,
  min: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statementTimeoutMillis: 15_000,
  queryTimeoutMillis: 30_000,
  applicationName: 'cartethyia-dashboard',
  maxRetries: 3,
  retryBackoffMillis: 250,
  maxResultRows: 10_000,
} as const satisfies Required<
  Pick<
    PgPoolOptions,
    | 'max'
    | 'min'
    | 'connectionTimeoutMillis'
    | 'idleTimeoutMillis'
    | 'statementTimeoutMillis'
    | 'queryTimeoutMillis'
    | 'applicationName'
    | 'maxRetries'
    | 'retryBackoffMillis'
    | 'maxResultRows'
  >
>

/** SQLSTATE codes the driver classifies as retryable transient errors. */
const RETRYABLE_SQLSTATE: Readonly<Record<string, true>> = {
  '08000': true, // connection_exception
  '08001': true, // sqlclient_unable_to_establish_sqlconnection
  '08003': true, // connection_does_not_exist
  '08004': true, // sqlserver_rejected_establishment_of_sqlconnection
  '08006': true, // connection_failure
  '57P01': true, // admin_shutdown
  '57P02': true, // crash_shutdown
  '57P03': true, // cannot_connect_now
}

/** Narrowed error shape — PostgreSQL error objects expose a `code` string. */
function isPgErrorWithCode(value: unknown): value is { code: string; message?: string } {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return false
  }
  const code = value.code
  return typeof code === 'string'
}

function isRetryableError(err: unknown): boolean {
  if (!isPgErrorWithCode(err)) return false
  return Object.prototype.hasOwnProperty.call(RETRYABLE_SQLSTATE, err.code)
}

const DEFAULT_LOGGER: PgLogger = {
  info: (message, context): void => {
    // eslint-disable-next-line no-console
    console.log(`[pg:info] ${message}`, context ?? {})
  },
  warn: (message, context): void => {
    // eslint-disable-next-line no-console
    console.warn(`[pg:warn] ${message}`, context ?? {})
  },
  error: (message, context): void => {
    // eslint-disable-next-line no-console
    console.error(`[pg:error] ${message}`, context ?? {})
  },
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InternalPool extends Pool {
  __cartethyia: PoolTelemetry
}

interface PoolTelemetry {
  queryCount: number
  acquireCount: number
  retryCount: number
  errorCount: number
  releaseCount: number
  max: number
}

/** Read process resident set size (RSS) in bytes — Node only. */
export function readResidentMemory(): number {
  return process.memoryUsage?.().rss ?? 0
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Pool construction
// ---------------------------------------------------------------------------

/** Build a configured `pg.Pool` with retry-aware query helpers. */
export function createPgPool(options: PgPoolOptions = {}): PgPoolHandle {
  const logger = options.logger ?? DEFAULT_LOGGER
  const merged: PgPoolHandle['options'] = {
    max: options.max ?? DEFAULT_OPTIONS.max,
    min: options.min ?? DEFAULT_OPTIONS.min,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_OPTIONS.connectionTimeoutMillis,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_OPTIONS.idleTimeoutMillis,
    statementTimeoutMillis: options.statementTimeoutMillis ?? DEFAULT_OPTIONS.statementTimeoutMillis,
    queryTimeoutMillis: options.queryTimeoutMillis ?? DEFAULT_OPTIONS.queryTimeoutMillis,
    applicationName: options.applicationName ?? DEFAULT_OPTIONS.applicationName,
    maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
    retryBackoffMillis: options.retryBackoffMillis ?? DEFAULT_OPTIONS.retryBackoffMillis,
    maxResultRows: options.maxResultRows ?? DEFAULT_OPTIONS.maxResultRows,
  }

  const config: PoolConfig = {
    user: options.user,
    password: options.password,
    host: options.host,
    port: options.port,
    database: options.database,
    ssl: options.ssl,
    max: merged.max,
    min: merged.min,
    idleTimeoutMillis: merged.idleTimeoutMillis,
    connectionTimeoutMillis: merged.connectionTimeoutMillis,
    statement_timeout: merged.statementTimeoutMillis,
    query_timeout: merged.queryTimeoutMillis,
    application_name: merged.applicationName,
  }
  if (options.connectionString) {
    config.connectionString = options.connectionString
  }

  const pool = new Pool(config) as InternalPool
  const telemetry: PoolTelemetry = {
    queryCount: 0,
    acquireCount: 0,
    retryCount: 0,
    errorCount: 0,
    releaseCount: 0,
    max: merged.max,
  }
  pool.__cartethyia = telemetry

  pool.on('error', (err: Error) => {
    telemetry.errorCount += 1
    logger.error('pool idle client error', { message: err.message })
  })

  return {
    pool,
    options: merged,
    logger,
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: ReadonlyArray<unknown> | undefined,
      queryOptions: QueryHelperOptions = {},
    ): Promise<QueryResult<R>> {
      return runWithRetry(pool, telemetry, logger, merged, text, values, queryOptions)
    },
    async withTransaction<R>(handler: PgTransactionHandler<R>): Promise<R> {
      return runWithTransaction(pool, telemetry, logger, handler)
    },
    async close(): Promise<void> {
      await pool.end()
    },
    stats(): PgPoolStats {
      return {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
        queryCount: telemetry.queryCount,
        acquireCount: telemetry.acquireCount,
        retryCount: telemetry.retryCount,
        errorCount: telemetry.errorCount,
        releaseCount: telemetry.releaseCount,
        max: telemetry.max,
        residentMemoryBytes: readResidentMemory(),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Query helper — retry + timeout + cap
// ---------------------------------------------------------------------------

async function runWithRetry<R extends QueryResultRow>(
  pool: InternalPool,
  telemetry: PoolTelemetry,
  logger: PgLogger,
  options: PgPoolHandle['options'],
  text: string,
  values: ReadonlyArray<unknown> | undefined,
  queryOptions: QueryHelperOptions,
): Promise<QueryResult<R>> {
  const cap = queryOptions.maxResultRows ?? options.maxResultRows
  const signal = queryOptions.signal
  const attempts = options.maxRetries + 1
  let lastErr: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    telemetry.queryCount += 1
    telemetry.acquireCount += 1

    let client: PoolClient | null = null
    try {
      client = await pool.connect()
      const result: QueryResult<R> = await client.query<R>({
        text,
        values: values === undefined ? [] : Array.from(values),
        name: queryOptions.name,
      })
      if (result.rows.length > cap) {
        throw new PgResultTooLargeError(cap, result.rows.length)
      }
      return result
    } catch (err) {
      telemetry.errorCount += 1
      if (err instanceof PgResultTooLargeError) {
        logger.error('query rejected: result set exceeded cap', {
          cap,
          rows: err.observed,
          text: text.replace(/\s+/g, ' ').trim().slice(0, 200),
        })
        throw err
      }
      if (signal?.aborted) {
        throw new Error('query aborted')
      }
      if (attempt < attempts && isRetryableError(err)) {
        telemetry.retryCount += 1
        const backoff = options.retryBackoffMillis * 2 ** (attempt - 1)
        logger.warn('transient postgres error; retrying', {
          attempt,
          backoffMs: backoff,
          code: isPgErrorWithCode(err) ? err.code : null,
        })
        await delay(backoff, signal)
        continue
      }
      lastErr = err
      break
    } finally {
      if (client) {
        client.release()
        telemetry.releaseCount += 1
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`postgres query failed: ${String(lastErr)}`)
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

async function runWithTransaction<R>(
  pool: InternalPool,
  telemetry: PoolTelemetry,
  logger: PgLogger,
  handler: PgTransactionHandler<R>,
): Promise<R> {
  telemetry.acquireCount += 1
  const client = await pool.connect()
  telemetry.queryCount += 1
  try {
    await client.query('BEGIN')
    const result = await handler(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      logger.error('rollback failed', {
        message: (rollbackErr as Error).message,
      })
    }
    telemetry.errorCount += 1
    throw err
  } finally {
    client.release()
    telemetry.releaseCount += 1
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a query's result row count exceeds the configured cap. */
export class PgResultTooLargeError extends Error {
  readonly cap: number
  readonly observed: number

  constructor(cap: number, observed: number) {
    super(`query returned ${observed} rows, exceeding the cap of ${cap}`)
    this.name = 'PgResultTooLargeError'
    this.cap = cap
    this.observed = observed
  }
}

// ---------------------------------------------------------------------------
// Singleton convenience
// ---------------------------------------------------------------------------

let singleton: PgPoolHandle | null = null

/** Get or lazily create a process-wide PostgreSQL handle. */
export function getPgPool(options: PgPoolOptions = {}): PgPoolHandle {
  if (singleton) return singleton
  singleton = createPgPool(options)
  return singleton
}

/** Close the singleton pool (mainly for tests / graceful shutdown). */
export async function closePgPool(): Promise<void> {
  if (!singleton) return
  const handle = singleton
  singleton = null
  await handle.close()
}

/** Reset singleton state without closing (test-only). */
export function __resetPgPoolForTests(): void {
  singleton = null
}

// Re-export for callers that need the raw `Pool`/`PoolClient` types.
export type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow }
