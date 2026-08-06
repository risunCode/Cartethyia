import { describe, expect, test } from "bun:test";
import { BackupService, hashConsolePassword, type SettingsRepository, type BackupRepository } from "../../src/console/services";
import type { BackupPayload, RestoreResult, RestoreValidation } from "../../src/storage";

const PASSWORD = "correct-battery-horse";

function makeSettings(passwordHash: string | null): SettingsRepository {
  return {
    get: async () => ({ passwordHash } as never),
    patchRuntime: async () => ({}) as never,
    setPasswordHash: async () => {},
    bumpPasswordVersion: async () => {},
  } as unknown as SettingsRepository;
}

function makeBackups(): BackupRepository {
  return {
    exportBackup: (): BackupPayload => ({ app: "cartethyia", version: 1, exportedAt: "2026-08-05T00:00:00.000Z", tables: {} as never }),
    restore: (_validation: Extract<RestoreValidation, { ok: true }>): RestoreResult => ({ restored: {} }),
  } as unknown as BackupRepository;
}

describe("BackupService — verifyPassword", () => {
  test("rejects a wrong or missing password against a configured hash", async () => {
    const hash = await hashConsolePassword(PASSWORD);
    const service = new BackupService(makeSettings(hash), makeBackups());
    expect((await service.verifyPassword("wrong")).ok).toBe(false);
    expect((await service.verifyPassword(undefined)).ok).toBe(false);
  });

  test("accepts the correct password against a configured hash", async () => {
    const hash = await hashConsolePassword(PASSWORD);
    const service = new BackupService(makeSettings(hash), makeBackups());
    expect((await service.verifyPassword(PASSWORD)).ok).toBe(true);
  });

  test("rejects when no password hash is configured", async () => {
    const service = new BackupService(makeSettings(null), makeBackups());
    expect((await service.verifyPassword("anything")).ok).toBe(false);
  });
});

describe("BackupService — resetAll", () => {
  test("requires a verified password before checking confirmation", async () => {
    const service = new BackupService(makeSettings(null), makeBackups());
    const result = await service.resetAll("x", "RESET ALL DATABASE AND RUNTIME", () => {}, () => {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  test("rejects a verified request without the correct confirmation text", async () => {
    const hash = await hashConsolePassword(PASSWORD);
    const service = new BackupService(makeSettings(hash), makeBackups());
    const result = await service.resetAll(PASSWORD, "WRONG", () => {}, () => {});
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  test("resets config and runtime when verified with the correct confirmation", async () => {
    const hash = await hashConsolePassword(PASSWORD);
    let configReset = false;
    let runtimeReset = false;
    const service = new BackupService(makeSettings(hash), makeBackups());
    const result = await service.resetAll(PASSWORD, "RESET ALL DATABASE AND RUNTIME", () => { configReset = true; }, () => { runtimeReset = true; });
    expect(result.ok).toBe(true);
    expect(configReset).toBe(true);
    expect(runtimeReset).toBe(true);
  });
});

describe("BackupService — restore", () => {
  test("requires a verified password before validating the payload", async () => {
    const service = new BackupService(makeSettings(null), makeBackups());
    const result = await service.restore("x", "not-a-backup");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  test("rejects an invalid payload shape with a 400 after verification", async () => {
    const hash = await hashConsolePassword(PASSWORD);
    const service = new BackupService(makeSettings(hash), makeBackups());
    const result = await service.restore(PASSWORD, "not-a-backup");
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

