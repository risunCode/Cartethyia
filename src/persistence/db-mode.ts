/** Database mode + data directory resolution. */
import { homedir } from "node:os";
import { join } from "node:path";

/** Which database backend the gateway boots against. */
export type DbMode = "full" | "lite";

/**
 * Reads `CARTETHYIA_DB_MODE`. Defaults to `full` so existing deployments never
 * change behavior unless they opt in; anything else fails closed at boot.
 */
export function resolveDbMode(env: NodeJS.ProcessEnv = process.env): DbMode {
  const raw = (env.CARTETHYIA_DB_MODE ?? "full").trim();
  if (raw !== "full" && raw !== "lite") {
    throw new Error(`CARTETHYIA_DB_MODE must be lite or full (got "${env.CARTETHYIA_DB_MODE}")`);
  }
  return raw;
}

/**
 * Writable root for gateway-owned on-disk state (PGlite data dir, and anything
 * else that needs the disk later). `CARTETHYIA_DATA_DIR` wins; otherwise the
 * per-OS convention: `%APPDATA%\\Cartethyia` on Windows, `~/Library/Application
 * Support/Cartethyia` on macOS, `$XDG_DATA_HOME/Cartethyia` (else
 * `~/.local/share/Cartethyia`) on Linux.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CARTETHYIA_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = env.APPDATA?.trim();
    if (roaming) return join(roaming, "Cartethyia");
    return join(homedir(), ".cartethyia");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cartethyia");
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "Cartethyia");
  return join(homedir(), ".local", "share", "Cartethyia");
}
