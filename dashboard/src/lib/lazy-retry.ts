import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * How long a recorded chunk-reload suppresses further automatic reloads for
 * the same route. A rebuild swaps hashed chunk URLs, so the first navigation
 * after a rebuild 404s the stale chunk: one reload fetches the fresh
 * `index.html` (served `no-cache`) and its new chunks. The TTL keeps a
 * permanently broken chunk from reload-looping while still allowing a fresh
 * auto-reload after the next rebuild minutes later.
 */
export const LAZY_RETRY_TTL_MS = 5 * 60 * 1000;

export function retryFlagKey(chunkName: string): string {
  return `cartethyia:lazy-retry:${chunkName}`;
}

/**
 * Pure decision: reload when no reload was recorded yet, the flag is garbage,
 * or the recorded reload is older than the TTL (i.e. a newer rebuild likely
 * swapped the chunks again).
 */
export function shouldReloadChunkLoad(flagValue: string | null, now: number): boolean {
  if (flagValue === null) return true;
  const at = Number(flagValue);
  if (!Number.isFinite(at)) return true;
  return now - at > LAZY_RETRY_TTL_MS;
}

export interface LazyRetryDeps {
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly reload?: () => void;
  readonly now?: () => number;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * `React.lazy` with one automatic page reload on chunk-load failure. A stale
 * hashed chunk URL (post-rebuild navigation) resolves itself via the reload;
 * a repeat failure surfaces to the route `ErrorBoundary` instead of looping.
 */
export function lazyWithRetry<T extends ComponentType<Record<string, unknown>>>(
  importer: () => Promise<{ default: T }>,
  chunkName: string,
  deps: LazyRetryDeps = {},
): LazyExoticComponent<T> {
  const storage = deps.storage ?? defaultStorage();
  const reload =
    deps.reload ??
    (() => {
      window.location.reload();
    });
  const now = deps.now ?? (() => Date.now());
  const key = retryFlagKey(chunkName);
  return lazy(async (): Promise<{ default: T }> => {
    try {
      const mod = await importer();
      try {
        storage?.removeItem(key);
      } catch {
        // Private-mode storage failures must never break route rendering.
      }
      return mod;
    } catch (error) {
      let flag: string | null = null;
      try {
        flag = storage?.getItem(key) ?? null;
      } catch {
        flag = null;
      }
      if (shouldReloadChunkLoad(flag, now())) {
        try {
          storage?.setItem(key, String(now()));
        } catch {
          // Reload anyway: worst case the boundary catches a repeat failure.
        }
        reload();
        return new Promise<{ default: T }>(() => {});
      }
      throw error;
    }
  });
}
