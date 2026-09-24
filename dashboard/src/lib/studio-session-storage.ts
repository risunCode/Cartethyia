/**
 * Persistence for the Model Lab's active-session pointer and playground key.
 * Reads fall back from sessionStorage to localStorage; writes are explicit per
 * scope so the key can stay per-visit while the active session survives.
 */
export const ACTIVE_KEY = "cartethyia:studio:active-session";
export const STUDIO_KEY_STORAGE = "cartethyia:studio:key";
export const STUDIO_PREFIX_STORAGE = "cartethyia:studio:key-prefix";

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
