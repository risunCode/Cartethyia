/**
 * Shared catalog for OpenCode providers (Free + Zen).
 *
 * Both providers query the same unauthenticated endpoint
 * (https://opencode.ai/zen/v1/models) for the live model list, so a single
 * module-level cache is correct — there is no benefit in fetching it twice.
 *
 * Free and Zen provider modules re-export the shared fetcher under their
 * provider-specific catalog names for clear callsites and test isolation.
 */

import { ProviderCallError } from "./index";

export type OpenCodeCapability = "chat" | "messages" | "responses";

export interface OpenCodeModelEntry {
  id: string;
}

interface CatalogCache {
  fetchedAt: number;
  promise: Promise<OpenCodeModelEntry[]>;
}

const CATALOG_TTL_MS = 60_000;
const UPSTREAM_CATALOG_URL = "https://opencode.ai/zen/v1/models";

let cache: CatalogCache | undefined;

/** Fetch (and cache for 60 s) the live OpenCode model catalog. */
export async function fetchOpenCodeCatalog(): Promise<OpenCodeModelEntry[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CATALOG_TTL_MS) return cache.promise;

  const promise = fetchCatalog();
  cache = { fetchedAt: now, promise };
  void promise.catch(() => {
    // A network failure must not poison the 60-second shared cache. Only
    // clear this promise; a newer fetch may already have replaced it.
    if (cache?.promise === promise) cache = undefined;
  });
  return promise;
}

async function fetchCatalog(): Promise<OpenCodeModelEntry[]> {
  const res = await fetch(UPSTREAM_CATALOG_URL);
  if (!res.ok) {
    cache = undefined;
    throw new ProviderCallError(503, "unavailable", "Could not fetch the OpenCode model catalog.");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    cache = undefined;
    throw new ProviderCallError(502, "malformed_response", "OpenCode catalog returned invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    cache = undefined;
    throw new ProviderCallError(502, "malformed_response", "OpenCode catalog returned an unexpected shape.");
  }

  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    cache = undefined;
    throw new ProviderCallError(502, "malformed_response", "OpenCode catalog is missing the model list.");
  }

  return data
    .map((raw: unknown): OpenCodeModelEntry | undefined => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const id = typeof (raw as Record<string, unknown>).id === "string"
        ? (raw as Record<string, unknown>).id as string
        : undefined;
      return id ? { id } : undefined;
    })
    .filter((m): m is OpenCodeModelEntry => m !== undefined);
}

export function findOpenCodeModel(
  catalog: OpenCodeModelEntry[],
  modelId: string,
): OpenCodeModelEntry | undefined {
  return catalog.find((m) => m.id === modelId);
}

export function selectCapability(
  _entry: OpenCodeModelEntry,
  requested: OpenCodeCapability,
): OpenCodeCapability | undefined {
  // Only "chat" is currently supported across both Free and Zen.
  return requested === "chat" ? "chat" : undefined;
}

/** Test-only: clear the shared catalog cache so tests remain hermetic. */
export function resetOpenCodeCatalogForTests(): void {
  cache = undefined;
}
