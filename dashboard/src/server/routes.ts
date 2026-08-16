/// <reference types="bun-types" />
/**
 * Route handlers for the dashboard's Bun auxiliary backend.
 *
 * Every handler takes its dependencies as parameters instead of reading a
 * module-level singleton — that's what makes them unit-testable with fake
 * `PgPoolHandle`/`SqliteLogHandle` objects and no real Postgres/SQLite.
 */

import type { PgPoolHandle } from '../lib/postgres'
import { isLogLevel } from '../lib/log-level'
import type { LogInsert, SqliteLogHandle } from '../lib/sqlite'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** `GET /internal/health` — Postgres reachability + sqlite pool stats. */
export async function handleHealth(pg: PgPoolHandle, sqlite: SqliteLogHandle): Promise<Response> {
  let postgres: 'ok' | 'error' = 'ok'
  try {
    await pg.query('SELECT 1')
  } catch {
    postgres = 'error'
  }
  return json({ postgres, sqlite: sqlite.stats() })
}

function isValidLogInsert(body: unknown): body is LogInsert {
  if (typeof body !== 'object' || body === null) return false
  const candidate = body as Record<string, unknown>
  if (typeof candidate.level !== 'string' || !isLogLevel(candidate.level)) return false
  if (typeof candidate.message !== 'string' || candidate.message.length === 0) return false
  return true
}

/** `POST /internal/logs` — insert one log row. */
export async function handleLogInsert(sqlite: SqliteLogHandle, body: unknown): Promise<Response> {
  if (!isValidLogInsert(body)) {
    return json({ error: 'invalid log payload: requires a known `level` and non-empty `message`' }, 400)
  }
  const result = sqlite.insertLog(body)
  return json({ id: Number(result.lastInsertRowid), changes: result.changes }, 201)
}

/** `GET /internal/logs` — read recent rows, optionally filtered/limited. */
export async function handleLogRead(sqlite: SqliteLogHandle, url: URL): Promise<Response> {
  const levelParam = url.searchParams.get('level')
  if (levelParam !== null && !isLogLevel(levelParam)) {
    return json({ error: `invalid level: ${levelParam}` }, 400)
  }
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10)
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    return json({ error: `invalid limit: ${limitParam}` }, 400)
  }
  const rows = sqlite.readLogs(limit, levelParam ?? undefined)
  return json(rows, 200)
}

/** Dispatch table used by the Bun entrypoint. */
export async function routeRequest(
  req: Request,
  pg: PgPoolHandle,
  sqlite: SqliteLogHandle,
): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'GET' && url.pathname === '/internal/health') {
    return handleHealth(pg, sqlite)
  }
  if (req.method === 'POST' && url.pathname === '/internal/logs') {
    const body = await req.json().catch(() => null)
    return handleLogInsert(sqlite, body)
  }
  if (req.method === 'GET' && url.pathname === '/internal/logs') {
    return handleLogRead(sqlite, url)
  }
  return json({ error: 'not found' }, 404)
}
