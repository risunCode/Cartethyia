/**
 * Settings repo — single-row table + runtime settings JSON blob.
 * Runtime settings override env config without restart (REQ-5.2).
 */

import { getDb } from "../client";
import { getConsoleEnv, type TrackMode, type ProxyAuthMode } from "../../env";
import { hashPassword } from "../../auth/password";

export const DEFAULT_CONSOLE_PASSWORD = "carte1234";

export interface RtkSettings {
  enabled: boolean;
  minChars: number;
  maxReductionPercent: number;
}

export interface RuntimeSettings {
  proxyAuthMode: ProxyAuthMode;
  trackPayloads: TrackMode;
  trackAssets: TrackMode;
  logRetentionDays: number;
  assetRetentionDays: number;
  maxFlightsPerIp: number;
  trustProxy: boolean;
  cacheMarkersEnabled: boolean;
  systemPrompt: string;
  sessionTtlHours: number;
  rtk: RtkSettings;
  /**
   * Blended USD-per-1M-token rates used for the "Est. Cost" stat card.
   * Per-model billing is genuinely provider-specific and not something this
   * app has a reliable live rate card for, so cost is a single configurable
   * blended estimate rather than fabricated per-model pricing. 0 (the
   * default) means "unconfigured" — the card shows a hint instead of $0.00.
   */
  costPerMillionInputTokens: number;
  costPerMillionOutputTokens: number;
}

export interface SettingsRow {
  id: number;
  password_hash: string | null;
  password_version: number;
  jwt_secret: string | null;
  settings_json: string;
  initialized_at: string;
  updated_at: string;
}

export interface Settings {
  passwordHash: string | null;
  passwordVersion: number;
  jwtSecret: string;
  runtime: RuntimeSettings;
  initializedAt: string;
  updatedAt: string;
}

function parseBoundedNumber(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function envDefaults(): RuntimeSettings {
  const env = getConsoleEnv();
  return {
    proxyAuthMode: env.proxyAuthMode,
    trackPayloads: env.trackPayloads,
    trackAssets: env.trackAssets,
    logRetentionDays: env.logRetentionDays,
    assetRetentionDays: env.assetRetentionDays,
    maxFlightsPerIp: 20,
    trustProxy: false,
    cacheMarkersEnabled: true,
    // Deployment-level defaults; a console PATCH persists an explicit value
    // in settings_json that then takes precedence on every future read.
    systemPrompt: Bun.env.CARTETHYIA_SYSTEM_PROMPT?.trim() ?? "",
    sessionTtlHours: env.sessionTtlHours,
    costPerMillionInputTokens: parseBoundedNumber(Bun.env.COST_PER_MILLION_INPUT_TOKENS, 0, 0, 1_000_000),
    costPerMillionOutputTokens: parseBoundedNumber(Bun.env.COST_PER_MILLION_OUTPUT_TOKENS, 0, 0, 1_000_000),
    rtk: {
      enabled: Bun.env.RTK_ENABLED === "true",
      minChars: parseBoundedNumber(Bun.env.RTK_MIN_CHARS, 1500, 500, 1_000_000),
      maxReductionPercent: parseBoundedNumber(Bun.env.RTK_MAX_REDUCTION_PERCENT, 35, 1, 90),
    },
  };
}

function toSettings(row: SettingsRow): Settings {
  let runtime = envDefaults();
  try {
    const parsed = JSON.parse(row.settings_json) as Partial<RuntimeSettings>;
    runtime = { ...runtime, ...parsed, rtk: { ...runtime.rtk, ...(parsed.rtk ?? {}) } };
  } catch {
    // corrupt JSON → fall back to defaults
  }
  return {
    passwordHash: row.password_hash,
    passwordVersion: row.password_version,
    jwtSecret: row.jwt_secret ?? "",
    runtime,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

/** Create the settings row on first use (default/env password + fresh JWT secret). */
export async function ensureSettings(): Promise<Settings> {
  const db = getDb();
  const existing = db.query("SELECT * FROM settings WHERE id = 1").get() as SettingsRow | null;
  if (existing) {
    if (existing.jwt_secret) return toSettings(existing);
    const secret = getConsoleEnv().jwtSecret ?? randomSecret();
    db.query("UPDATE settings SET jwt_secret = ?, updated_at = ? WHERE id = 1").run(secret, new Date().toISOString());
    return toSettings({ ...existing, jwt_secret: secret });
  }
  const env = getConsoleEnv();
  const now = new Date().toISOString();
  const hash = await hashPassword(env.password ?? DEFAULT_CONSOLE_PASSWORD);
  const secret = env.jwtSecret ?? randomSecret();
  db.query(
    "INSERT INTO settings (id, password_hash, password_version, jwt_secret, settings_json, initialized_at, updated_at) VALUES (1, ?, 1, ?, '{}', ?, ?)"
  ).run(hash, secret, now, now);
  return toSettings({
    id: 1,
    password_hash: hash,
    password_version: 1,
    jwt_secret: secret,
    settings_json: "{}",
    initialized_at: now,
    updated_at: now,
  });
}

export function getSettings(): Settings | null {
  const row = getDb().query("SELECT * FROM settings WHERE id = 1").get() as SettingsRow | null;
  return row ? toSettings(row) : null;
}

export function patchRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
  const current = getSettings();
  if (!current) throw new Error("settings not initialized");
  const next: RuntimeSettings = {
    ...current.runtime,
    ...patch,
    rtk: { ...current.runtime.rtk, ...(patch.rtk ?? {}) },
  };
  getDb()
    .query("UPDATE settings SET settings_json = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(next), new Date().toISOString());
  return next;
}

/** Store a new password hash and bump password_version (invalidates all JWTs). */
export function setPasswordHash(hash: string): void {
  getDb()
    .query("UPDATE settings SET password_hash = ?, password_version = password_version + 1, updated_at = ? WHERE id = 1")
    .run(hash, new Date().toISOString());
}

/** Bump password_version without changing the password (logout-all). */
export function bumpPasswordVersion(): void {
  getDb()
    .query("UPDATE settings SET password_version = password_version + 1, updated_at = ? WHERE id = 1")
    .run(new Date().toISOString());
}

export function rotateJwtSecret(): string {
  const secret = randomSecret();
  getDb()
    .query("UPDATE settings SET jwt_secret = ?, password_version = password_version + 1, updated_at = ? WHERE id = 1")
    .run(secret, new Date().toISOString());
  return secret;
}
