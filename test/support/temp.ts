/**
 * Windows-safe temp directory cleanup.
 *
 * Windows defers releasing freshly-closed SQLite handles (WAL/-shm cleanup
 * races with the OS), so a single `rmSync` of a temp data dir can hit EBUSY.
 * Node's `rmSync` has built-in retry support (maxRetries + retryDelay); the
 * GC + sleep before the call helps release lingering bun:sqlite handles.
 *
 * EBUSY/ENOTEMPTY/EPERM from Windows file-handle lag are swallowed — the test
 * itself has already passed by the time cleanup runs, and the OS reclaims the
 * temp dir on next reboot or temp sweep. Genuine errors are re-thrown.
 */
import { rmSync } from "node:fs";

export function removeTempDir(dir: string): void {
  // Force GC to release any lingering SQLite handles before attempting removal.
  try { Bun.gc(true); } catch {}
  Bun.sleepSync(300);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 200 });
    return;
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      const code = err.code;
      // Windows file-handle lag — not a test failure.
      if (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM") {
        console.warn(`[cleanup] deferring temp dir ${dir} — Windows file handle race`);
        return;
      }
      // Already gone.
      if (code === "ENOENT") return;
    }
    throw err;
  }
}
