/**
 * PostgreSQL migration runner.
 *
 * Reads numbered SQL files from a directory (default `dashboard/migrations`)
 * and applies them in lexicographic order. Each migration must have a paired
 * `down` SQL file (e.g. `0001_initial.sql` paired with `0001_initial.down.sql`)
 * for rollback support.
 *
 * State is tracked in a `schema_migrations` table that records every applied
 * version, its checksum, and execution duration. Re-running the runner is
 * idempotent — already-applied versions are skipped.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import type { PgPoolHandle } from './postgres'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A migration loaded from disk. */
export interface MigrationFile {
  /** Version identifier (the numeric prefix, e.g. `0001`). */
  version: string
  /** Human-friendly name (basename without `.sql`/`.down.sql`). */
  name: string
  /** Absolute path of the forward SQL file. */
  forwardPath: string
  /** Forward SQL body. */
  forwardSql: string
  /** Absolute path of the rollback SQL file, if present. */
  rollbackPath: string | null
  /** Rollback SQL body. */
  rollbackSql: string | null
}

/** Status reported by `status()`. */
export interface MigrationStatus {
  applied: AppliedMigration[]
  pending: MigrationFile[]
  total: number
}

/** A row stored in the `schema_migrations` table. */
export interface AppliedMigration {
  version: string
  name: string
  checksum: string
  applied_at: string
  duration_ms: number
}

/** Options for `runMigrations`. */
export interface RunMigrationsOptions {
  /** Override the migrations directory. */
  directory?: string
  /** Run pending migrations only (default true). Set false to also re-run failed ones. */
  pendingOnly?: boolean
  /** Apply all migrations up to and including this version. */
  upTo?: string
  /** Logger; falls back to console. */
  logger?: MigrationLogger
}

export interface MigrationLogger {
  info: (message: string, context?: Record<string, unknown>) => void
  warn: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, context?: Record<string, unknown>) => void
}

/** Options for `rollbackMigrations`. */
export interface RollbackMigrationsOptions {
  /** Override the migrations directory. */
  directory?: string
  /** Roll back to (but not including) this version. */
  target?: string
  /** Number of migrations to roll back (mutually exclusive with `target`). */
  steps?: number
  /** Logger. */
  logger?: MigrationLogger
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    checksum     TEXT NOT NULL,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms  INTEGER NOT NULL
);
` as const

const DOWN_SUFFIX = '.down.sql'

const DEFAULT_LOGGER: MigrationLogger = {
  info: (message, context): void => {
    // eslint-disable-next-line no-console
    console.log(`[migrations:info] ${message}`, context ?? {})
  },
  warn: (message, context): void => {
    // eslint-disable-next-line no-console
    console.warn(`[migrations:warn] ${message}`, context ?? {})
  },
  error: (message, context): void => {
    // eslint-disable-next-line no-console
    console.error(`[migrations:error] ${message}`, context ?? {})
  },
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a migration's forward file has no matching rollback file. */
export class MissingRollbackError extends Error {
  readonly version: string
  readonly migrationName: string

  constructor(version: string, name: string) {
    super(`migration ${version}_${name} is missing its .down.sql rollback file`)
    this.name = 'MissingRollbackError'
    this.version = version
    this.migrationName = name
  }
}

/** Thrown when a migration's checksum changed since it was applied. */
export class ChecksumMismatchError extends Error {
  readonly version: string

  constructor(version: string) {
    super(`migration ${version} has been modified after being applied`)
    this.name = 'ChecksumMismatchError'
    this.version = version
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Discover migration files from disk. Forward files (without `.down.`) are listed. */
export async function discoverMigrations(directory: string): Promise<MigrationFile[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const forwardPaths = entries.filter((entry) => entry.endsWith('.sql') && !entry.endsWith(DOWN_SUFFIX))
  forwardPaths.sort()

  const files: MigrationFile[] = []
  for (const entry of forwardPaths) {
    const { version, name } = parseMigrationName(entry)
    const forwardPath = path.join(directory, entry)
    const forwardSql = await fs.readFile(forwardPath, 'utf8')
    const rollbackEntry = `${version}_${name}${DOWN_SUFFIX}`
    const rollbackPath = path.join(directory, rollbackEntry)
    let rollbackSql: string | null = null
    try {
      rollbackSql = await fs.readFile(rollbackPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    files.push({
      version,
      name,
      forwardPath,
      forwardSql,
      rollbackPath: rollbackSql === null ? null : rollbackPath,
      rollbackSql,
    })
  }
  return files
}

/** Parse `0001_initial.sql` → `{ version: '0001', name: 'initial' }`. */
export function parseMigrationName(filename: string): { version: string; name: string } {
  const stem = filename.endsWith('.sql') ? filename.slice(0, -'.sql'.length) : filename
  const underscore = stem.indexOf('_')
  if (underscore === -1) {
    return { version: stem, name: '' }
  }
  return { version: stem.slice(0, underscore), name: stem.slice(underscore + 1) }
}

/** Compute a stable checksum for a migration body. */
export function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ---------------------------------------------------------------------------
// Status & apply
// ---------------------------------------------------------------------------

/** Snapshot the migration state of the database. */
export async function status(
  pool: PgPoolHandle,
  options: { directory?: string } = {},
): Promise<MigrationStatus> {
  const directory = options.directory ?? defaultMigrationsDir()
  await ensureMigrationsTable(pool)
  const [files, applied] = await Promise.all([discoverMigrations(directory), loadApplied(pool)])
  const appliedSet = new Map(applied.map((row) => [row.version, row]))
  const pending = files.filter((file) => !appliedSet.has(file.version))
  return { applied, pending, total: files.length }
}

/** Apply all pending migrations in order. */
export async function runMigrations(
  pool: PgPoolHandle,
  options: RunMigrationsOptions = {},
): Promise<{ applied: AppliedMigration[]; pending: AppliedMigration[] }> {
  const logger = options.logger ?? DEFAULT_LOGGER
  const directory = options.directory ?? defaultMigrationsDir()
  await ensureMigrationsTable(pool)
  const [files, applied] = await Promise.all([discoverMigrations(directory), loadApplied(pool)])
  const appliedMap = new Map(applied.map((row) => [row.version, row]))

  const newApplied: AppliedMigration[] = []
  const skipped: AppliedMigration[] = []

  for (const file of files) {
    if (options.upTo !== undefined && file.version > options.upTo) break
    const existing = appliedMap.get(file.version)
    const fileChecksum = checksum(file.forwardSql)
    if (existing) {
      if (existing.checksum !== fileChecksum) {
        throw new ChecksumMismatchError(file.version)
      }
      skipped.push(existing)
      continue
    }
    if (options.pendingOnly === false) {
      // Caller asked to re-run anyway — fall through to apply.
    }
    const appliedRow = await applyMigration(pool, file, logger)
    newApplied.push(appliedRow)
  }

  if (newApplied.length === 0) {
    logger.info('no pending migrations', { skipped: skipped.length })
  } else {
    logger.info('migrations complete', {
      applied: newApplied.length,
      skipped: skipped.length,
    })
  }

  return { applied: newApplied, pending: skipped }
}

/** Roll back migrations. Either `target` (exclusive) or `steps` must be provided. */
export async function rollbackMigrations(
  pool: PgPoolHandle,
  options: RollbackMigrationsOptions = {},
): Promise<{ rolledBack: AppliedMigration[] }> {
  if (options.target === undefined && options.steps === undefined) {
    throw new Error('rollbackMigrations requires either `target` or `steps`')
  }
  const logger = options.logger ?? DEFAULT_LOGGER
  const directory = options.directory ?? defaultMigrationsDir()
  await ensureMigrationsTable(pool)
  const files = await discoverMigrations(directory)
  const fileByVersion = new Map(files.map((file) => [file.version, file]))
  const applied = (await loadApplied(pool)).slice().sort((a, b) => b.version.localeCompare(a.version))

  let selected = applied
  if (options.target !== undefined) {
    selected = applied.filter((row) => row.version > options.target!)
  } else if (options.steps !== undefined) {
    selected = applied.slice(0, Math.max(options.steps, 0))
  }

  const rolledBack: AppliedMigration[] = []
  for (const row of selected) {
    const file = fileByVersion.get(row.version)
    if (!file || file.rollbackSql === null) {
      throw new MissingRollbackError(row.version, row.name)
    }
    await rollBackMigration(pool, file, logger)
    rolledBack.push(row)
  }

  logger.info('rollback complete', { rolledBack: rolledBack.length })
  return { rolledBack }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function defaultMigrationsDir(): string {
  // ESM modules: derive the directory from `import.meta.url`.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', 'migrations')
}

async function ensureMigrationsTable(pool: PgPoolHandle): Promise<void> {
  await pool.query(MIGRATIONS_TABLE_DDL)
}

interface AppliedRow {
  version: string
  name: string
  checksum: string
  applied_at: string
  duration_ms: number
}

async function loadApplied(pool: PgPoolHandle): Promise<AppliedMigration[]> {
  const result = await pool.query<AppliedRow>(
    'SELECT version, name, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version ASC',
  )
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    applied_at: typeof row.applied_at === 'string' ? row.applied_at : String(row.applied_at),
    duration_ms: row.duration_ms,
  }))
}

async function applyMigration(
  pool: PgPoolHandle,
  file: MigrationFile,
  logger: MigrationLogger,
): Promise<AppliedMigration> {
  const start = Date.now()
  logger.info('applying migration', { version: file.version, name: file.name })
  await pool.withTransaction(async (client) => {
    await client.query(file.forwardSql)
    await client.query(
      'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
      [file.version, file.name, checksum(file.forwardSql), Date.now() - start],
    )
  })
  const duration = Date.now() - start
  logger.info('migration applied', { version: file.version, durationMs: duration })
  return {
    version: file.version,
    name: file.name,
    checksum: checksum(file.forwardSql),
    applied_at: new Date().toISOString(),
    duration_ms: duration,
  }
}

async function rollBackMigration(
  pool: PgPoolHandle,
  file: MigrationFile,
  logger: MigrationLogger,
): Promise<void> {
  if (file.rollbackSql === null) {
    throw new MissingRollbackError(file.version, file.name)
  }
  logger.info('rolling back migration', { version: file.version, name: file.name })
  await pool.withTransaction(async (client) => {
    await client.query(file.rollbackSql!)
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [file.version])
  })
}
