/** Database mode + data directory resolution. */
import { homedir } from "node:os";
import { join } from "node:path";

/** Which database backend the gateway boots against. */
export type DbMode = "full" | "lite";

/**
 * Reads `CARTETHYIA_DB_MODE`, which is required and has no default.
 *
 * It used to default to `full`, which left the same key carrying three
 * different answers: `.env.example` shipped `lite`, the `bun setup` prompt
 * offered `lite`, and an environment that set nothing at all booted `full`.
 * The third one is the one that bit — a clone without a `.env` came up in Full
 * mode and then failed on a missing `DATABASE_URL`, when the documented intent
 * was the self-contained Lite path.
 *
 * Failing closed is the honest fix: the two modes are different databases with
 * different migration sets (`migrations/lite-sqlite3/` vs
 * `migrations/full-postgres/`), so guessing one silently picks which migrations
 * an operator's data is read against. `bun setup`, `scripts/install/lite.sh`,
 * `.env.example`, and `docker-compose.yml` all set it explicitly,
 * so requiring it costs an existing deployment nothing.
 */
export function resolveDbMode(env: NodeJS.ProcessEnv = process.env): DbMode {
  const raw = env.CARTETHYIA_DB_MODE?.trim();
  if (!raw) {
    const setupCommand = env.CARTETHYIA_CONFIG_DIR ? "cartethyia setup" : "bun setup";
    const configHint = env.CARTETHYIA_CONFIG_DIR
      ? `the user's Cartethyia config file under ${env.CARTETHYIA_CONFIG_DIR}`
      : ".env";
    throw new Error(
      `CARTETHYIA_DB_MODE is required and must be lite or full — run \`${setupCommand}\`, or set it in ${configHint} (lite is embedded SQLite; full needs DATABASE_URL)`,
    );
  }
  if (raw !== "full" && raw !== "lite") {
    throw new Error(`CARTETHYIA_DB_MODE must be lite or full (got "${env.CARTETHYIA_DB_MODE}")`);
  }
  return raw;
}

/**
 * Writable root for gateway-owned on-disk state (the SQLite database file, and
 * anything else that needs the disk later). `CARTETHYIA_DATA_DIR` wins; otherwise the
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
