import { ProviderCallError } from "../index";

export type OpenCodeCapability = "chat" | "messages" | "responses";

export interface OpenCodeModelEntry {
  id: string;
}

interface CatalogCache {
  fetchedAt: number;
  promise: Promise<OpenCodeModelEntry[]>;
}

const CATALOG_TTL_MS = 60_000;
// Same live catalog OpenCode Free reads (https://opencode.ai/zen/v1/models is
// unauthenticated) — kept as an independent module/cache from
// `opencode-free/catalog.ts` rather than shared so the two providers' catalog
// lifecycles stay fully decoupled, matching the rest of this codebase's
// one-module-per-provider pattern.
const UPSTREAM_CATALOG_URL = "https://opencode.ai/zen/v1/models";

let cache: CatalogCache | undefined;

export async function fetchOpenCodeZenCatalog(): Promise<OpenCodeModelEntry[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CATALOG_TTL_MS) return cache.promise;

  const promise = fetchCatalog();
  cache = { fetchedAt: now, promise };
  return promise;
}

async function fetchCatalog(): Promise<OpenCodeModelEntry[]> {
  const res = await fetch(UPSTREAM_CATALOG_URL);
  if (!res.ok) {
    cache = undefined;
    throw new ProviderCallError(503, "unavailable", "Could not fetch the OpenCode Zen model catalog.");
  }

  const body: unknown = await res.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    cache = undefined;
    throw new ProviderCallError(502, "malformed_response", "OpenCode Zen catalog returned an unexpected shape.");
  }

  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    cache = undefined;
    throw new ProviderCallError(502, "malformed_response", "OpenCode Zen catalog is missing the model list.");
  }

  return data
    .map((raw: unknown): OpenCodeModelEntry | undefined => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const id = typeof (raw as Record<string, unknown>).id === "string" ? (raw as Record<string, unknown>).id as string : undefined;
      return id ? { id } : undefined;
    })
    .filter((m): m is OpenCodeModelEntry => m !== undefined);
}

export function findOpenCodeModel(
  catalog: OpenCodeModelEntry[],
  modelId: string
): OpenCodeModelEntry | undefined {
  return catalog.find((m) => m.id === modelId);
}

export function selectCapability(
  _entry: OpenCodeModelEntry,
  requested: OpenCodeCapability
): OpenCodeCapability | undefined {
  return requested === "chat" ? "chat" : undefined;
}

/** Test-only: clear the module-level catalog cache so tests remain hermetic. */
export function resetOpenCodeZenCatalogForTests(): void {
  cache = undefined;
}
