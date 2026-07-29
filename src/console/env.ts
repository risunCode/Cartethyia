/**
 * Console env — parsed lazily per call (cheap, no FS), so tests can override
 * Bun.env without module reloads. Never touch the filesystem here.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";

export type TrackMode = "none" | "meta" | "store";
export type ProxyAuthMode = "open" | "api_key";

export interface ConsoleEnv {
  enabled: boolean;
  /** Console mount path, always "/console" in practice. */
  path: string;
  password: string | undefined;
  jwtSecret: string | undefined;
  sessionTtlHours: number;
  dataDir: string;
  dbPath: string;
  logDir: string;
  assetDir: string;
  payloadDir: string;
  proxyAuthMode: ProxyAuthMode;
  bootstrapKey: string | undefined;
  bootstrapKeyName: string;
  trackPayloads: TrackMode;
  trackAssets: TrackMode;
  logRetentionDays: number;
  assetRetentionDays: number;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseTrackMode(raw: string | undefined, fallback: TrackMode): TrackMode {
  if (raw === "store" || raw === "meta" || raw === "none") return raw;
  return fallback;
}

export function getConsoleEnv(): ConsoleEnv {
  const e = Bun.env;
  const isTest = e.NODE_ENV === "test";
  const dataDir = e.DATA_DIR ?? (isTest ? join(tmpdir(), `cartethyia-test-${process.pid}`) : join(process.cwd(), "data"));
  return {
    enabled: e.CONSOLE_ENABLED !== "false",
    path: e.CONSOLE_PATH ?? "/console",
    password: e.CONSOLE_PASSWORD,
    jwtSecret: e.CONSOLE_JWT_SECRET,
    sessionTtlHours: boundedNumber(e.CONSOLE_SESSION_TTL_HOURS, 12, 1, 720),
    dataDir,
    dbPath: e.DB_PATH ?? join(dataDir, "cartethyia.sqlite"),
    logDir: e.LOG_DIR ?? join(dataDir, "logs"),
    assetDir: e.ASSET_DIR ?? join(dataDir, "assets"),
    payloadDir: join(dataDir, "payloads"),
    proxyAuthMode: e.PROXY_AUTH_MODE === "open" ? "open" : "api_key",
    bootstrapKey: e.BOOTSTRAP_PROXY_API_KEY,
    bootstrapKeyName: e.BOOTSTRAP_PROXY_API_KEY_NAME ?? "bootstrap",
    trackPayloads: parseTrackMode(e.TRACK_PAYLOADS, "store"),
    trackAssets: parseTrackMode(e.TRACK_ASSETS, "meta"),
    logRetentionDays: boundedNumber(e.LOG_RETENTION_DAYS, 14, 1, 365),
    assetRetentionDays: boundedNumber(e.ASSET_RETENTION_DAYS, 7, 1, 365),
  };
}
