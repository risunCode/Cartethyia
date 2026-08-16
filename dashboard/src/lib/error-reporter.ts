/**
 * Fire-and-forget forwarder for operator-facing frontend errors to the
 * dashboard's Bun auxiliary backend (`/internal/logs`, see `src/server/`).
 *
 * Never throws and never returns a promise the caller has to await — a
 * failed report must not affect the page the user is looking at.
 */

import type { LogLevel } from './sqlite'

export function reportError(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  void fetch('/internal/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level, message, context }),
  }).catch(() => undefined)
}
