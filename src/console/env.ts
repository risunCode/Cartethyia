/**
 * Console env — parsed lazily per call (cheap, no FS), so tests can override
 * Bun.env without module reloads. Never touch the filesystem here.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateNumeric } from "../utils/config-helpers";

export type PayloadTrackMode = "none" | "meta";
export type TrackMode = PayloadTrackMode | "store";
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
  /**
   * Runtime request/error/console-log history and per-request detail
   * metadata - a separate SQLite database (WAL) from `dbPath`, so
   * high-frequency traffic logging never contends with the config db
   * (API keys, providers, settings). See AGENTS.md "Persistence and logs".
   */
  runtimeDbPath: string;
  assetDir: string;
  proxyAuthMode: ProxyAuthMode;
  bootstrapKey: string | undefined;
  bootstrapKeyName: string;
  trackPayloads: PayloadTrackMode;
  trackAssets: TrackMode;
  logRetentionDays: number;
  assetRetentionDays: number;
}

function parseTrackMode(raw: string | undefined, fallback: TrackMode): TrackMode {
  if (raw === "store" || raw === "meta" || raw === "none") return raw;
  return fallback;
}

function parsePayloadTrackMode(raw: string | undefined, fallback: PayloadTrackMode): PayloadTrackMode {
  // `store` was accepted by older releases; payload bodies are deliberately
  // never persisted now, so legacy/invalid values safely downgrade to meta.
  return raw === "none" ? "none" : raw === "meta" ? "meta" : fallback;
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
    sessionTtlHours: validateNumeric(e.CONSOLE_SESSION_TTL_HOURS, { fallback: 12, min: 1, max: 720 }),
    dataDir,
    dbPath: e.DB_PATH ?? join(dataDir, "cartethyia.sqlite"),
    runtimeDbPath: e.RUNTIME_DB_PATH ?? join(dataDir, "runtime.sqlite"),
    assetDir: e.ASSET_DIR ?? join(dataDir, "assets"),
    proxyAuthMode: e.PROXY_AUTH_MODE === "open" ? "open" : "api_key",
    bootstrapKey: e.BOOTSTRAP_PROXY_API_KEY,
    bootstrapKeyName: e.BOOTSTRAP_PROXY_API_KEY_NAME ?? "bootstrap",
    trackPayloads: parsePayloadTrackMode(e.TRACK_PAYLOADS, "meta"),
    trackAssets: parseTrackMode(e.TRACK_ASSETS, "meta"),
    logRetentionDays: validateNumeric(e.LOG_RETENTION_DAYS, { fallback: 14, min: 1, max: 365 }),
    assetRetentionDays: validateNumeric(e.ASSET_RETENTION_DAYS, { fallback: 7, min: 1, max: 365 }),
  };
}
