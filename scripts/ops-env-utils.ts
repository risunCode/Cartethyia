import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the repository root.
 *
 * Every operational script needs it, and deriving it per script is how
 * `ops-doctor` came to look for `.env` one directory *above* the checkout
 * (it used `../..` from `scripts/`, which is only correct from a nested dir).
 * One authority, derived from this module's own location, so a script can
 * never disagree with its neighbours about where the project lives.
 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path of the repository's `.env`. */
export const ENV_PATH = resolve(PROJECT_ROOT, ".env");

/** Absolute path of the lcov report `bun test --coverage-dir=coverage` writes. */
export const COVERAGE_LCOV_PATH = resolve(PROJECT_ROOT, "coverage", "lcov.info");

/**
 * Reads a dotenv-style file without overriding already-exported variables.
 */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const content = await readFile(path, "utf8");
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}
/**
 * Shared utilities for setup and doctor scripts.
 * These are extracted for testability and code reuse.
 */

export interface ProbeResult {
  success: boolean;
  error?: string;
}

/**
 * Opens a TCP connection to `host:port` and resolves once it connects, errors,
 * or the timeout elapses. The socket is always closed so a probe never leaves a
 * half-open connection behind.
 */
export async function probeTcpService(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  const { promise, resolve } = Promise.withResolvers<ProbeResult>();

  const timeoutHandle = setTimeout(() => {
    resolve({ success: false, error: "timeout" });
  }, timeoutMs);

  Bun.connect({
    hostname: host,
    port: port,
    socket: {
      open: () => {
        clearTimeout(timeoutHandle);
        resolve({ success: true });
      },
      data: () => {},
      error: (err) => {
        clearTimeout(timeoutHandle);
        resolve({ success: false, error: String(err) });
      },
    },
  })
    .then((socket) => {
      socket.end();
    })
    .catch((err) => {
      clearTimeout(timeoutHandle);
      resolve({ success: false, error: String(err) });
    });

  return promise;
}

/**
 * Parses a service URL and requires an explicit host and port.
 * Returns null if the URL is invalid or incomplete.
 */
export function parseServiceUrl(url: string): { host: string; port: number } | null {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname || !urlObj.port) return null;
    return { host: urlObj.hostname, port: Number(urlObj.port) };
  } catch {
    return null;
  }
}

export type LocalPlatform = "windows" | "macos" | "linux" | "unknown";

/** Detects the host platform once so setup/doctor share identical labels. */
export function getLocalPlatform(): LocalPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

/**
 * Returns actionable hints for the configured local/external service.
 * These are hints only: setup never assumes Docker or silently mutates an
 * external service. Windows users commonly run PostgreSQL through Laragon;
 * Redis may be native, WSL-backed, or external.
 */
export function getOsHints(service: "postgres" | "redis"): string[] {
  const platform = getLocalPlatform();
  if (platform === "windows") {
    return service === "postgres"
      ? [
          "Windows / Laragon:",
          "  Start Laragon (Start All) and ensure PostgreSQL is enabled.",
          "  Verify PostgreSQL is listening on the DATABASE_URL host/port (usually 5432).",
          "  External PostgreSQL is also supported — keep DATABASE_URL unchanged and reachable.",
        ]
      : [
          "Windows / Redis:",
          "  Start Redis through WSL, a native Redis-compatible service, or an external host.",
          "  Verify Redis is listening on the REDIS_URL host/port (usually 6379).",
          "  Or set REDIS_MODE=single_instance_local and omit REDIS_URL.",
        ];
  }
  if (platform === "macos") {
    return service === "postgres"
      ? [
          "macOS / Homebrew:",
          "  brew services start postgresql@16 (or the installed PostgreSQL version).",
          "  External PostgreSQL is also supported — verify DATABASE_URL reachability.",
        ]
      : [
          "macOS / Redis:",
          "  brew services start redis, or use an external Redis instance.",
          "  Or set REDIS_MODE=single_instance_local and omit REDIS_URL.",
        ];
  }
  if (platform === "linux") {
    return service === "postgres"
      ? [
          "Linux / systemd:",
          "  sudo systemctl start postgresql (or the installed PostgreSQL service).",
          "  External PostgreSQL is also supported — verify DATABASE_URL reachability.",
        ]
      : [
          "Linux / Redis:",
          "  sudo systemctl start redis-server (or the installed Redis service).",
          "  Or set REDIS_MODE=single_instance_local and omit REDIS_URL.",
        ];
  }
  return [
    `${service} is not reachable on this platform.`,
    "Verify the configured service URL or use an external service.",
  ];
}
/**
 * Checks if a string contains a configured placeholder value.
 */
export function hasPlaceholderSecrets(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("replace-with") ||
    normalized.includes("replace_me") ||
    normalized.includes("your_")
  );
}
