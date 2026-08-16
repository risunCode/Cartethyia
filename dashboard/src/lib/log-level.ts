/**
 * `LogLevel` and its helpers, split out of `sqlite.ts` on purpose: this
 * module has zero dependencies, so anything that only needs the log-level
 * concept (e.g. the aux-backend route handlers, the frontend error
 * reporter) can import it as a real value without transitively pulling in
 * `bun:sqlite` — which Vite/Vitest cannot resolve outside a Bun runtime.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export function isLogLevel(value: string): value is LogLevel {
  return Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, value)
}
