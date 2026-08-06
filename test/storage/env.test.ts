import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPersistenceEnv } from "../../src/storage/main/env";

const ENV_KEYS = [
  "DATA_DIR",
  "DB_PATH",
  "RUNTIME_DB_PATH",
  "ASSET_DIR",
  "LOG_RETENTION_DAYS",
  "ASSET_RETENTION_DAYS",
  "MAX_FLIGHTS_PER_IP",
  "NODE_ENV",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete Bun.env[key];
}

afterEach(() => clearEnv());

describe("getPersistenceEnv — defaults", () => {
  test("applies documented fallbacks for retention and per-IP cap", () => {
    const env = getPersistenceEnv();
    expect(env.logRetentionDays).toBe(14);
    expect(env.assetRetentionDays).toBe(7);
    expect(env.maxFlightsPerIp).toBe(15);
  });

  test("falls back to a per-pid tmpdir under NODE_ENV=test when DATA_DIR is absent", () => {
    Bun.env.NODE_ENV = "test";
    delete Bun.env.DATA_DIR;
    const env = getPersistenceEnv();
    expect(env.dataDir).toBe(join(tmpdir(), `cartethyia-test-${process.pid}`));
    expect(env.dbPath).toBe(join(env.dataDir, "cartethyia.sqlite"));
    expect(env.runtimeDbPath).toBe(join(env.dataDir, "runtime.sqlite"));
    expect(env.assetDir).toBe(join(env.dataDir, "assets"));
  });

  test("falls back to ./data under non-test NODE_ENV when DATA_DIR is absent", () => {
    Bun.env.NODE_ENV = "production";
    delete Bun.env.DATA_DIR;
    const env = getPersistenceEnv();
    expect(env.dataDir).toBe(join(process.cwd(), "data"));
  });
});

describe("getPersistenceEnv — explicit overrides", () => {
  test("DATA_DIR drives every derived path", () => {
    Bun.env.DATA_DIR = "/srv/cartethyia";
    const env = getPersistenceEnv();
    expect(env.dataDir).toBe("/srv/cartethyia");
    expect(env.dbPath).toBe(join("/srv/cartethyia", "cartethyia.sqlite"));
    expect(env.runtimeDbPath).toBe(join("/srv/cartethyia", "runtime.sqlite"));
    expect(env.assetDir).toBe(join("/srv/cartethyia", "assets"));
  });

  test("individual path env vars override the derived defaults", () => {
    Bun.env.DATA_DIR = "/srv/cartethyia";
    Bun.env.DB_PATH = "/var/db/config.sqlite";
    Bun.env.RUNTIME_DB_PATH = "/var/db/runtime.sqlite";
    Bun.env.ASSET_DIR = "/var/assets";
    const env = getPersistenceEnv();
    expect(env.dbPath).toBe("/var/db/config.sqlite");
    expect(env.runtimeDbPath).toBe("/var/db/runtime.sqlite");
    expect(env.assetDir).toBe("/var/assets");
    // dataDir is still the declared boundary, not a derived file path.
    expect(env.dataDir).toBe("/srv/cartethyia");
  });
});

describe("getPersistenceEnv — bounded retention days (clamped to 1..365)", () => {
  test.each([
    ["30", 30],
    ["1.9", 1],
    ["0.5", 1],
    ["0", 1],
    ["-12", 1],
    ["400", 365],
    ["365", 365],
  ])("clamps %s to %i", (raw, expected) => {
    Bun.env.LOG_RETENTION_DAYS = raw;
    expect(getPersistenceEnv().logRetentionDays).toBe(expected);
  });

  test("falls back to 14 for non-numeric or non-finite values", () => {
    Bun.env.LOG_RETENTION_DAYS = "not-a-number";
    expect(getPersistenceEnv().logRetentionDays).toBe(14);
    Bun.env.LOG_RETENTION_DAYS = "Infinity";
    expect(getPersistenceEnv().logRetentionDays).toBe(14);
  });

  test("asset retention shares the same clamping policy", () => {
    Bun.env.ASSET_RETENTION_DAYS = "400";
    expect(getPersistenceEnv().assetRetentionDays).toBe(365);
    Bun.env.ASSET_RETENTION_DAYS = "abc";
    expect(getPersistenceEnv().assetRetentionDays).toBe(7);
  });
});

describe("getPersistenceEnv — bounded per-IP flights (clamped to 1..10000)", () => {
  test.each([
    ["100", 100],
    ["0", 1],
    ["0.9", 1],
    ["-5", 1],
    ["99999", 10_000],
    ["10000", 10_000],
  ])("clamps %s to %i", (raw, expected) => {
    Bun.env.MAX_FLIGHTS_PER_IP = raw;
    expect(getPersistenceEnv().maxFlightsPerIp).toBe(expected);
  });

  test("falls back to 15 for non-numeric values", () => {
    Bun.env.MAX_FLIGHTS_PER_IP = "garbage";
    expect(getPersistenceEnv().maxFlightsPerIp).toBe(15);
  });
});
