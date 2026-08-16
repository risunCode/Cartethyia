/// <reference types="bun-types" />
/**
 * Dashboard auxiliary backend entrypoint.
 *
 * Applies pending Postgres migrations, initializes the sqlite log pool, then
 * serves `/internal/*` (see `routes.ts`). Run via `bun run src/server/index.ts`
 * (or `npm run server` from `dashboard/`) — never imported by the Vite
 * browser bundle.
 */

import { getPgPool } from '../lib/postgres'
import { runMigrations } from '../lib/migrations'
import { getSqliteLogPool } from '../lib/sqlite'
import { routeRequest } from './routes'

const PORT = Number(process.env.CARTETHYIA_DASHBOARD_SERVER_PORT ?? 8787)

async function main(): Promise<void> {
  const pool = getPgPool({ connectionString: process.env.CARTETHYIA_DASHBOARD_DATABASE_URL })

  try {
    await runMigrations(pool)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dashboard-server] migration failure, refusing to serve on a half-applied schema:', err)
    process.exit(1)
  }

  const sqlite = getSqliteLogPool({ filename: process.env.CARTETHYIA_DASHBOARD_SQLITE_PATH ?? 'data/logs.db' })

  Bun.serve({
    port: PORT,
    fetch: (req) => routeRequest(req, pool, sqlite),
  })

  // eslint-disable-next-line no-console
  console.log(`[dashboard-server] listening on :${PORT}`)
}

void main()
