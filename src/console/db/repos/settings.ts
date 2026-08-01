/**
 * Settings repo — single-row table + runtime settings JSON blob.
 * Runtime settings override env config without restart (REQ-5.2).
 */

import { getDb } from "../client";
import { getConsoleEnv, type TrackMode, type ProxyAuthMode } from "../../env";
import { hashPassword } from "../../auth/password";

export const DEFAULT_CONSOLE_PASSWORD = "carte1234";

export interface RuntimeSettings {
  proxyAuthMode: ProxyAuthMode;
  trackPayloads: TrackMode;
  trackAssets: TrackMode;
  logRetentionDays: number;
  assetRetentionDays: number;
  maxFlightsPerIp: number;
  trustProxy: boolean;
  cacheMarkersEnabled: boolean;
  sessionTtlHours: number;
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
    sessionTtlHours: env.sessionTtlHours,
  };
}

function toSettings(row: SettingsRow): Settings {
  let runtime = envDefaults();
  try {
    const parsed = JSON.parse(row.settings_json) as Partial<RuntimeSettings>;
    runtime = { ...runtime, ...parsed };
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
  const next: RuntimeSettings = { ...current.runtime, ...patch };
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
