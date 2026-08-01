/**
 * Unit tests for src/console/db/repos/settings.ts \u2014 the single-row
 * settings table + runtime settings JSON blob (REQ-5.2).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { useIsolatedDataDir } from "./helpers";
import {
  ensureSettings,
  getSettings,
  patchRuntimeSettings,
  setPasswordHash,
  bumpPasswordVersion,
  rotateJwtSecret,
  DEFAULT_CONSOLE_PASSWORD,
} from "../../src/console/db/repos/settings";
import { getDb } from "../../src/console/db/client";
import { hashPassword } from "../../src/console/auth/password";

beforeEach(() => {
  useIsolatedDataDir();
});

describe("getSettings \u2014 before initialization", () => {
  test("returns null when the settings row has never been created", () => {
    expect(getSettings()).toBeNull();
  });
});

describe("ensureSettings \u2014 first-run initialization", () => {
  test("creates a settings row with a password hash and jwt secret", async () => {
    const settings = await ensureSettings();
    expect(settings.passwordHash).toBeTruthy();
    expect(settings.jwtSecret).toBeTruthy();
    expect(settings.passwordVersion).toBe(1);
  });

  test("the default password hash validates against DEFAULT_CONSOLE_PASSWORD", async () => {
    const settings = await ensureSettings();
    const { verifyPassword } = await import("../../src/console/auth/password");
    expect(await verifyPassword(DEFAULT_CONSOLE_PASSWORD, settings.passwordHash!)).toBe(true);
  });

  test("is idempotent \u2014 a second call returns the same row unchanged", async () => {
    const first = await ensureSettings();
    const second = await ensureSettings();
    expect(second.passwordHash).toBe(first.passwordHash);
    expect(second.jwtSecret).toBe(first.jwtSecret);
    expect(second.passwordVersion).toBe(first.passwordVersion);
  });

  test("backfills a missing jwt_secret on an existing row without touching the password", async () => {
    const initial = await ensureSettings();
    getDb().query("UPDATE settings SET jwt_secret = NULL WHERE id = 1").run();
    const repaired = await ensureSettings();
    expect(repaired.jwtSecret).toBeTruthy();
    expect(repaired.passwordHash).toBe(initial.passwordHash);
  });

  test("populates runtime settings with sane defaults", async () => {
    const settings = await ensureSettings();
    expect(settings.runtime.proxyAuthMode).toBe("open");
    expect(settings.runtime.maxFlightsPerIp).toBe(20);
  });
});

describe("patchRuntimeSettings", () => {
  test("throws when settings have not been initialized yet", () => {
    expect(() => patchRuntimeSettings({ proxyAuthMode: "api_key" })).toThrow("settings not initialized");
  });

  test("merges a partial patch into the existing runtime settings", async () => {
    await ensureSettings();
    const next = patchRuntimeSettings({ proxyAuthMode: "api_key", maxFlightsPerIp: 5 });
    expect(next.proxyAuthMode).toBe("api_key");
    expect(next.maxFlightsPerIp).toBe(5);
    // Untouched fields survive the patch.
    expect(next.trustProxy).toBe(false);
  });

  test("persists the patch \u2014 a fresh getSettings() reflects it", async () => {
    await ensureSettings();
    patchRuntimeSettings({ sessionTtlHours: 3 });
    expect(getSettings()?.runtime.sessionTtlHours).toBe(3);
  });
});

describe("setPasswordHash", () => {
  test("updates the password hash and bumps the version", async () => {
    const initial = await ensureSettings();
    const newHash = await hashPassword("a-new-password");
    setPasswordHash(newHash);
    const updated = getSettings()!;
    expect(updated.passwordHash).toBe(newHash);
    expect(updated.passwordVersion).toBe(initial.passwordVersion + 1);
  });
});

describe("bumpPasswordVersion", () => {
  test("increments the version without changing the password hash", async () => {
    const initial = await ensureSettings();
    bumpPasswordVersion();
    const updated = getSettings()!;
    expect(updated.passwordVersion).toBe(initial.passwordVersion + 1);
    expect(updated.passwordHash).toBe(initial.passwordHash);
  });
});

describe("rotateJwtSecret", () => {
  test("returns a new secret different from the previous one", async () => {
    const initial = await ensureSettings();
    const rotated = rotateJwtSecret();
    expect(rotated).not.toBe(initial.jwtSecret);
    expect(rotated.length).toBeGreaterThan(0);
  });

  test("also bumps the password version (invalidates existing JWTs)", async () => {
    const initial = await ensureSettings();
    rotateJwtSecret();
    expect(getSettings()!.passwordVersion).toBe(initial.passwordVersion + 1);
  });

  test("persists the rotated secret", async () => {
    await ensureSettings();
    const rotated = rotateJwtSecret();
    expect(getSettings()!.jwtSecret).toBe(rotated);
  });
});

describe("toSettings \u2014 corrupt settings_json resilience", () => {
  test("falls back to runtime defaults when settings_json is malformed", async () => {
    await ensureSettings();
    getDb().query("UPDATE settings SET settings_json = ? WHERE id = 1").run("{not valid json");
    const settings = getSettings()!;
    // Should silently recover to env defaults rather than throwing.
    expect(settings.runtime.proxyAuthMode).toBe("open");
    expect(settings.runtime.maxFlightsPerIp).toBe(20);
  });
});
