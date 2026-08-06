export type AccountHealthStatus = "healthy" | "refreshing" | "error" | "disabled" | "reauthentication-required" | "cooling_down";

export const MAX_HEALTH_MESSAGE_LENGTH = 240;
export const MAX_VISIBLE_HEALTH_STATUS_LENGTH = 128;

export interface AccountHealthSnapshot {
  status: AccountHealthStatus;
  errorKind: string | null;
  failureKind?: string | null;
  statusCode: number | null;
  sanitizedMessage: string | null;
  retryAt: string | null;
}

export interface RouteHealthSnapshot {
  status: AccountHealthStatus;
  errorKind?: string | null;
  failureKind?: string | null;
  statusCode: number | null;
  sanitizedMessage: string | null;
  retryAt: string | null;
}

export interface RouteHealthView {
  health: RouteHealthSnapshot | null;
}

export interface AccountHealthAccount {
  active: boolean;
  health: AccountHealthSnapshot | null;
}

function formatRetryCountdown(retryAt: string | null, now: number): string {
  if (!retryAt) return "";
  const retryTime = Date.parse(retryAt);
  if (!Number.isFinite(retryTime)) return "";
  const remaining = Math.max(0, retryTime - now);
  if (remaining <= 0) return "retrying soon";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes >= 60) return `retry in ${Math.ceil(minutes / 60)}h`;
  return `retry in ${minutes}m`;
}

function boundedHealthMessage(message: string | null): string | null {
  if (!message) return null;
  const normalized = message.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= MAX_HEALTH_MESSAGE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_HEALTH_MESSAGE_LENGTH - 1)}…`;
}

function capVisibleStatus(status: string): string {
  if (status.length <= MAX_VISIBLE_HEALTH_STATUS_LENGTH) return status;
  return `${status.slice(0, MAX_VISIBLE_HEALTH_STATUS_LENGTH - 1)}…`;
}

function formatHealthSnapshot(health: RouteHealthSnapshot, active: boolean, now: number, capDisplay: boolean): string | null {
  if (!active) return health.status === "disabled" ? "Disabled" : null;
  if (health.status === "healthy" || health.status === "refreshing") return null;
  if (health.status === "disabled") return "Disabled";

  let statusLabel = health.errorKind ?? health.failureKind ?? "Provider error";
  if (health.status === "reauthentication-required") statusLabel = "Re-authentication required";
  else if (health.statusCode === 502) statusLabel = "502 Bad Gateway";
  else if (health.statusCode !== null) statusLabel = `${health.statusCode} error`;

  const message = boundedHealthMessage(health.sanitizedMessage);
  const statusPrefix = health.statusCode === null ? null : `[${health.statusCode}]`;
  let detail = statusLabel;
  if (message) detail = statusPrefix && !message.startsWith(statusPrefix) ? `${statusPrefix}: ${message}` : message;
  const retry = formatRetryCountdown(health.retryAt, now);
  const withRetry = retry ? `${detail} · ${retry}` : detail;
  return capDisplay ? capVisibleStatus(withRetry) : withRetry;
}

/** Returns a bounded, normalized health message for accessible labels and titles. */
export function formatHealthAccessibleStatus(health: RouteHealthSnapshot | null, active = true, now = Date.now()): string | null {
  if (!health) return null;
  if (!active) return health.status === "disabled" ? "Disabled" : null;
  if (health.status === "healthy" || health.status === "refreshing") return null;
  if (health.status === "disabled") return "Disabled";
  return formatHealthSnapshot(health, active, now, false);
}

/** Returns the interval used for health polling while a page is visible. */
export function healthPollingInterval(isVisible: boolean, intervalMs = 10_000): number | false {
  return isVisible ? intervalMs : false;
}

/**
 * Formats the persisted account failure for the compact account table.
 * The upstream message stays visible after its HTTP status so failover is
 * observable instead of looking like a silent account or proxy switch.
 */
export function formatAccountHealthStatus(account: AccountHealthAccount, now = Date.now()): string | null {
  if (!account.health) return null;
  return formatHealthSnapshot(account.health, account.active, now, true);
}

/** Returns the full bounded account health text used by title and aria-label attributes. */
export function formatAccountHealthAccessibleStatus(account: AccountHealthAccount, now = Date.now()): string | null {
  return formatHealthAccessibleStatus(account.health, account.active, now);
}

/** Formats a route health snapshot for a proxy or routing transition. */
export function formatRouteHealthStatus(route: RouteHealthView, now = Date.now()): string | null {
  if (!route.health) return null;
  return formatHealthSnapshot(route.health, true, now, true);
}
