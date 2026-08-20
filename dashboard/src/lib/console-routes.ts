/**
 * Browser-facing console route contract.
 *
 * The browser calls consoleApi with a console-resource suffix (the shared client
 * supplies `/console`). Keep this matrix deliberately small and explicit:
 * browser resources never use the client-ingress namespace or
 * non-standard HTTP methods.
 */
import type { ConsoleHttpMethod } from "./api";

export interface ConsoleRouteContract {
  readonly route: string;
  readonly methods: readonly ConsoleHttpMethod[];
  /** Allow-listed query keys. Omitted means this route has no query string. */
  readonly queryKeys?: readonly string[];
}

const MAX_CONSOLE_QUERY_KEYS = 8;
const MAX_CONSOLE_QUERY_VALUE_LENGTH = 128;
const MAX_CONSOLE_QUERY_LENGTH = 512;

function hasAllowedQuery(route: ConsoleRouteContract, query: string): boolean {
  if (query.length === 0) return true;
  if (!route.queryKeys || query.length > MAX_CONSOLE_QUERY_LENGTH) return false;
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (keys.length === 0 || keys.length > MAX_CONSOLE_QUERY_KEYS) return false;
  if (keys.some((key) => !route.queryKeys?.includes(key))) return false;
  return keys.every((key) => {
    const value = params.get(key) ?? "";
    return value.length > 0 && value.length <= MAX_CONSOLE_QUERY_VALUE_LENGTH;
  });
}


/**
 * Canonical route patterns used by retained dashboard requests.
 * `:segment` denotes one percent-encoded, non-empty path segment.
 */
export const CONSOLE_ROUTE_MATRIX = [
  { route: "/auth/login", methods: ["POST"] },
  { route: "/auth/logout", methods: ["POST"] },
  { route: "/auth/session", methods: ["GET"] },
  { route: "/auth/refresh", methods: ["POST"] },
  { route: "/auth/oauth/start", methods: ["POST"], queryKeys: ["providerId"] },
  { route: "/auth/oauth/refresh", methods: ["POST"] },
  { route: "/auth/oauth/reauth", methods: ["POST"] },
  { route: "/auth/oauth/sessions/:sessionId", methods: ["GET"] },
  { route: "/auth/oauth/sessions/:sessionId/complete", methods: ["POST"] },
  { route: "/auth/oauth/sessions/:sessionId/cancel", methods: ["POST"] },
  { route: "/dashboard", methods: ["GET"] },
  { route: "/settings", methods: ["GET", "PATCH", "POST"] },
  { route: "/proxies", methods: ["GET", "POST"] },
  { route: "/proxies/:proxyId", methods: ["PATCH", "DELETE"] },
  { route: "/telemetry/overview", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/requests", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/requests/:requestId", methods: ["GET"] },
  { route: "/telemetry/errors", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/upstream", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/usage", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/telemetry/clients", methods: ["GET"], queryKeys: ["from", "to", "period", "bucket", "cursor", "limit", "group_by"] },
  { route: "/logs", methods: ["GET"], queryKeys: ["from", "to", "level", "scope", "origin", "limit"] },
  { route: "/client-errors", methods: ["POST"] },
  { route: "/catalog/providers", methods: ["GET"] },
  { route: "/providers/:providerId/accounts", methods: ["GET", "POST"], queryKeys: ["limit", "cursor"] },
  { route: "/providers/:providerId/accounts/batch", methods: ["PATCH", "POST"] },
  { route: "/providers/:providerId/accounts/batch-delete", methods: ["POST"] },
  { route: "/providers/:providerId/accounts/:accountId", methods: ["POST", "DELETE"] },
  { route: "/accounts", methods: ["GET"] },
  { route: "/accounts/:accountId/quota", methods: ["GET", "POST"] },
] as const satisfies readonly ConsoleRouteContract[];
export type ConsoleRoutePattern = (typeof CONSOLE_ROUTE_MATRIX)[number]["route"];

/**
 * Admin-plane SSE streams the browser opens through the EventSource
 * transport (`consoleStreamUrl`). Deliberately exact static routes — the
 * stream surface has no `:params` and no query string, so membership is a
 * plain string check.
 */
export const CONSOLE_STREAM_ROUTES = [
  "/telemetry/in-flight/stream",
  "/logs/stream",
] as const satisfies readonly string[];

const ROUTE_SEGMENT = "[^/?#]+";

function routePattern(contract: ConsoleRouteContract): RegExp {
  const expression = contract.route
    .split("/")
    .map((segment) => segment.startsWith(":") ? ROUTE_SEGMENT : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return new RegExp(`^${expression}$`);
}

const COMPILED_ROUTES = CONSOLE_ROUTE_MATRIX.map((contract) => ({ ...contract, pattern: routePattern(contract) }));

/** Returns the matching retained route contract for an admin suffix. */
function findConsoleRouteContract(route: string): ConsoleRouteContract | undefined {
  if (route.includes("://") || route.startsWith("/v1/") || route.startsWith("/v2/")) return undefined;
  const separator = route.indexOf("?");
  const path = separator < 0 ? route : route.slice(0, separator);
  const query = separator < 0 ? "" : route.slice(separator + 1);
  if (query.includes("?")) return undefined;
  return COMPILED_ROUTES.find((contract) => contract.pattern.test(path) && hasAllowedQuery(contract, query));
}

/** Returns whether a suffix and standard method are in the retained contract. */
export function isDocumentedConsoleRoute(route: string, method: ConsoleHttpMethod): boolean {
  const contract = findConsoleRouteContract(route);
  return contract !== undefined && contract.methods.includes(method);
}
