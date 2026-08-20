/**
 * Fire-and-forget forwarder for operator-facing frontend errors to the
 * daemon console ingest route (`/console/client-errors`).
 *
 * Never throws and never returns a promise the caller has to await — a
 * failed report must not affect the page the user is looking at.
 */

import { sanitizeErrorMessage } from './api'
import { redactOperatorValue } from './console-api'
import type { LogLevel } from './log-level'

export function reportError(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const payload =
    context === undefined
      ? { level, message: sanitizeErrorMessage(message, 'request failed') }
      : {
          level,
          message: sanitizeErrorMessage(message, 'request failed'),
          context: redactOperatorValue(context),
        }

  void fetch('/console/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    keepalive: true,
    body: JSON.stringify(payload),
  }).catch(() => undefined)
}
