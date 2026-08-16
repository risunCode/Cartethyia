/**
 * Test-only companions for the console route contract.
 *
 * `serializeConsoleQuery` (and its bounds) used to live in
 * `src/lib/console-routes.ts` but had no runtime consumers — pages build
 * their query strings inline and the browser validates them through the
 * public `isDocumentedConsoleRoute` predicate. The copies below must stay
 * aligned with the private rules in `console-routes.ts`; transport-contract
 * tests keep that honest by round-tripping serialized queries through the
 * public predicate and by checking the runtime rejects what this helper
 * refuses to build.
 */
import type { ConsoleRouteContract } from "../../src/lib/console-routes";

export interface ConsoleQueryOptions {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export const MAX_CONSOLE_QUERY_KEYS = 8;
export const MAX_CONSOLE_QUERY_VALUE_LENGTH = 128;
export const MAX_CONSOLE_QUERY_LENGTH = 512;

/** Serializes only allow-listed, bounded query values for a route contract. */
export function serializeConsoleQuery(route: ConsoleRouteContract, values: ConsoleQueryOptions): string {
  const allowed = route.queryKeys ?? [];
  const params = new URLSearchParams();
  for (const key of allowed) {
    const value = values[key];
    if (value === undefined || value === null || value === "") continue;
    const text = String(value);
    if (text.length > MAX_CONSOLE_QUERY_VALUE_LENGTH) throw new Error("API query value is too long");
    params.set(key, text);
  }
  const query = params.toString();
  if (query.length > MAX_CONSOLE_QUERY_LENGTH) throw new Error("API query is too long");
  return query.length > 0 ? `?${query}` : "";
}
