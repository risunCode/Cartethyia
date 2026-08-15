/**
 * Browser-facing V2 admin route contract.
 *
 * The browser calls daemonApi with an admin-resource suffix (the shared client
 * supplies `/v2/admin`). Keep this matrix deliberately small and explicit:
 * browser resources never use the legacy client-ingress namespace or
 * non-standard HTTP methods.
 */
import type { DaemonHttpMethod } from "./api";

export interface DaemonRouteContract {
  readonly route: string;
  readonly methods: readonly DaemonHttpMethod[];
  /** Allow-listed query keys. Omitted means this route has no query string. */
  readonly queryKeys?: readonly string[];
}

export interface DaemonQueryOptions {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export const MAX_DAEMON_QUERY_KEYS = 8;
export const MAX_DAEMON_QUERY_VALUE_LENGTH = 128;
export const MAX_DAEMON_QUERY_LENGTH = 512;

function hasAllowedQuery(route: DaemonRouteContract, query: string): boolean {
  if (query.length === 0) return true;
  if (!route.queryKeys || query.length > MAX_DAEMON_QUERY_LENGTH) return false;
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (keys.length === 0 || keys.length > MAX_DAEMON_QUERY_KEYS) return false;
  if (keys.some((key) => !route.queryKeys?.includes(key))) return false;
  return keys.every((key) => {
    const value = params.get(key) ?? "";
    return value.length > 0 && value.length <= MAX_DAEMON_QUERY_VALUE_LENGTH;
  });
}

/** Serializes only allow-listed, bounded query values for a route contract. */
export function serializeDaemonQuery(route: DaemonRouteContract, values: DaemonQueryOptions): string {
  const allowed = route.queryKeys ?? [];
  const params = new URLSearchParams();
  for (const key of allowed) {
    const value = values[key];
    if (value === undefined || value === null || value === "") continue;
    const text = String(value);
    if (text.length > MAX_DAEMON_QUERY_VALUE_LENGTH) throw new Error("daemon query value is too long");
    params.set(key, text);
  }
  const query = params.toString();
  if (query.length > MAX_DAEMON_QUERY_LENGTH) throw new Error("daemon query is too long");
  return query.length > 0 ? `?${query}` : "";
}


/**
 * Canonical route patterns used by retained dashboard requests.
 * `:segment` denotes one percent-encoded, non-empty path segment.
 */
export const DAEMON_ROUTE_MATRIX = [
  { route: "/auth/login", methods: ["POST"] },
  { route: "/auth/logout", methods: ["POST"] },
  { route: "/auth/session", methods: ["GET"] },
  { route: "/auth/refresh", methods: ["POST"] },
  { route: "/auth/oauth/start", methods: ["POST"], queryKeys: ["providerId"] },
  { route: "/auth/oauth/sessions/:sessionId", methods: ["GET"] },
  { route: "/auth/oauth/sessions/:sessionId/complete", methods: ["POST"] },
  { route: "/auth/oauth/sessions/:sessionId/cancel", methods: ["POST"] },
  { route: "/dashboard", methods: ["GET"] },
  { route: "/settings", methods: ["GET", "PATCH", "POST"] },
  { route: "/telemetry/overview", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/requests", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/errors", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/upstream", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/usage", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/clients", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/console/logs", methods: ["GET"], queryKeys: ["from", "to", "limit"] },
  { route: "/console/web-request", methods: ["POST"] },
  { route: "/catalog/providers", methods: ["GET"] },
  { route: "/catalog/models", methods: ["GET"] },
  { route: "/providers", methods: ["GET", "POST"] },
  { route: "/providers/:providerId", methods: ["GET", "PATCH", "DELETE"] },
  { route: "/providers/:providerId/accounts", methods: ["GET", "POST"], queryKeys: ["limit", "cursor"] },
  { route: "/providers/:providerId/accounts/batch", methods: ["PATCH", "POST"] },
  { route: "/providers/:providerId/accounts/:accountId", methods: ["PATCH", "POST", "DELETE"] },
  { route: "/providers/:providerId/models", methods: ["POST", "PATCH"] },
  { route: "/providers/:providerId/models/:modelId", methods: ["POST", "PATCH", "DELETE"] },
  { route: "/providers/:providerId/models/fetch", methods: ["POST"] },
  { route: "/providers/:providerId/oauth/start", methods: ["POST"] },
  { route: "/oauth/sessions/:sessionId", methods: ["GET"] },
  { route: "/oauth/sessions/:sessionId/complete", methods: ["POST"] },
  { route: "/oauth/sessions/:sessionId/cancel", methods: ["POST"] },
  { route: "/oauth/refresh", methods: ["POST"] },
  { route: "/accounts", methods: ["GET"] },
  { route: "/accounts/:accountId/quota", methods: ["GET", "POST"] },
  { route: "/accounts/:accountId/quota/refresh", methods: ["POST"] },
  { route: "/quota/refresh", methods: ["POST"] },
  { route: "/proxies", methods: ["GET", "POST"], queryKeys: ["limit"] },
  { route: "/proxies/:proxyId", methods: ["PATCH", "DELETE"] },
  { route: "/proxies/:proxyId/test", methods: ["POST"] },
  { route: "/proxies/search", methods: ["POST"] },
  { route: "/proxies/import", methods: ["POST"] },
  { route: "/proxies/scrape", methods: ["POST"] },
  { route: "/proxies/scrape/countries", methods: ["GET"] },
  { route: "/proxies/scrape/catalog", methods: ["GET"] },
  { route: "/proxy-settings", methods: ["GET", "POST"] },
  { route: "/web-search-routing", methods: ["GET"] },
  { route: "/tools/cache/:cacheName", methods: ["POST"] },
  { route: "/tools/reindex", methods: ["POST"] },
  { route: "/tools/probe", methods: ["POST"] },
  { route: "/tools/restart", methods: ["POST"] },
  { route: "/backups", methods: ["GET", "POST"] },
  { route: "/backups/:backupId/download", methods: ["GET"] },
  { route: "/backups/:backupId/restore", methods: ["POST"] },
  { route: "/backups/:backupId", methods: ["DELETE"] },
] as const satisfies readonly DaemonRouteContract[];
export type DaemonRoutePattern = (typeof DAEMON_ROUTE_MATRIX)[number]["route"];

const ROUTE_SEGMENT = "[^/?#]+";

function routePattern(contract: DaemonRouteContract): RegExp {
  const expression = contract.route
    .split("/")
    .map((segment) => segment.startsWith(":") ? ROUTE_SEGMENT : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return new RegExp(`^${expression}$`);
}

const COMPILED_ROUTES = DAEMON_ROUTE_MATRIX.map((contract) => ({ ...contract, pattern: routePattern(contract) }));

/** Returns the matching retained route contract for an admin suffix. */
export function findDaemonRouteContract(route: string): DaemonRouteContract | undefined {
  if (route.includes("://") || route.startsWith("/v1/") || route.startsWith("/v2/")) return undefined;
  const separator = route.indexOf("?");
  const path = separator < 0 ? route : route.slice(0, separator);
  const query = separator < 0 ? "" : route.slice(separator + 1);
  if (query.includes("?")) return undefined;
  return COMPILED_ROUTES.find((contract) => contract.pattern.test(path) && hasAllowedQuery(contract, query));
}

/** Returns whether a suffix and standard method are in the retained contract. */
export function isDocumentedDaemonRoute(route: string, method: DaemonHttpMethod): boolean {
  const contract = findDaemonRouteContract(route);
  return contract !== undefined && contract.methods.includes(method);
}
