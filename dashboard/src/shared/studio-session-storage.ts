/**
 * Persistence for the Model Lab's active-session pointer and playground key.
 * Reads fall back from sessionStorage to localStorage; writes are explicit per
 * scope so the key can stay per-visit while the active session survives.
 */
export const ACTIVE_KEY = "cartethyia:studio:active-session";
export const STUDIO_KEY_STORAGE = "cartethyia:studio:key";
export const STUDIO_PREFIX_STORAGE = "cartethyia:studio:key-prefix";
/**
 * The Model Lab's thinking level. Local (not session) scope so the operator's
 * choice survives a page change and a fresh visit, matching how the provider
 * Models card persists its own effort.
 */
export const STUDIO_THINK_STORAGE = "cartethyia:studio:thinking-level";

/**
 * Reads a persisted level from a closed set. A stored value is untrusted —
 * devtools and an older build can both write it — so anything outside `allowed`
 * resolves to `fallback` instead of reaching the request body as
 * `reasoning_effort: <garbage>`. The comparison is exact, like
 * `parseConsoleTheme`, so a near-miss is rejected rather than silently coerced.
 */
export function readEnumStorage<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readStorage(key);
  if (raw === null) return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Persists a level chosen from a closed set. Storage failure is non-fatal. */
export function writeEnumStorage(key: string, value: string): void {
  writeLocal(key, value);
}

export function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is an optimization; the active session still remains usable.
  }
}
export function writeSession(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* private mode: key is re-issued per visit */
  }
}
