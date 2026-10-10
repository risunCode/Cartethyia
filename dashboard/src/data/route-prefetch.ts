import { isCancelledError, type QueryClient } from "@tanstack/react-query";
import { consoleRequest } from "./api";
import { assertSystemHealth, querySignal } from "../lib/api/validators";
import { DASHBOARD_QUERY_OPTIONS } from "./query-policy";
import { queryKeys } from "./query-keys";

const ROUTE_PREFETCH_FAILURE_COOLDOWN_MS = 5_000;

// This state is intentionally scoped to each browser-side QueryClient. It is a
// bounded negative cache for the one allowlisted route-prefetch read and does
// not affect the normal query or mutation paths that use the same QueryClient.
const routePrefetchFailureUntil = new WeakMap<QueryClient, number>();

/**
 * Prefetches only the inexpensive, non-sensitive health read used by the shell.
 * Credential, share-link, request-detail, mutation, and quota reads are
 * intentionally absent so intent does not trigger privileged or upstream work.
 */
export function prefetchRouteIntent(queryClient: QueryClient, pathname: string): Promise<void> {
  if (pathname !== "/" && pathname !== "/providers" && pathname !== "/proxy") {
    return Promise.resolve();
  }

  const now = Date.now();
  const failureUntil = routePrefetchFailureUntil.get(queryClient);
  if (failureUntil !== undefined) {
    if (failureUntil > now) return Promise.resolve();
    routePrefetchFailureUntil.delete(queryClient);
  }

  return queryClient
    .fetchQuery({
      queryKey: queryKeys.system.health,
      queryFn: (context) =>
        consoleRequest<unknown>("/system/health", { signal: querySignal(context) }).then(
          assertSystemHealth,
        ),
      ...DASHBOARD_QUERY_OPTIONS,
    })
    .then(() => {
      routePrefetchFailureUntil.delete(queryClient);
    })
    .catch((error: unknown) => {
      if (!isCancelledError(error)) {
        routePrefetchFailureUntil.set(queryClient, Date.now() + ROUTE_PREFETCH_FAILURE_COOLDOWN_MS);
      }
    });
}
