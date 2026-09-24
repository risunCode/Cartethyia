import { describe, expect, test } from "bun:test";
import { resolveRedisMode } from "../../../src/persistence/readiness";
import { DrizzleRuntimeSettingsStore } from "../../../src/console/settings/store";

const REMOVED_RUNTIME_SETTING_KEYS = [
  "tokenSaverProfile",
  "ponytailEnabled",
  "cavemanEnabled",
  "redisModeDesired",
] as const;

describe("DrizzleRuntimeSettingsStore", () => {
  /**
   * Minimal Drizzle stand-in. `insert().values(...)` records what was written so
   * `returning()` can hand back the persisted row, which is what the upsert path
   * maps into the response — an empty `returning()` would make every write
   * assertion below a tautology over the defaults.
   */
  function makeDb() {
    function chain(result: unknown[]) {
      const builder = {
        from() { return builder; },
        where() { return builder; },
        limit() { return builder; },
        values(written?: Record<string, unknown>) { return chain(written ? [written] : result); },
        onConflictDoUpdate() { return builder; },
        returning() { return Promise.resolve(result); },
        async then(resolve: (value: unknown[]) => void) { resolve(result); },
      };
      return builder;
    }
    return {
      select() { return chain([]); },
      insert() { return chain([]); },
    };
  }

  test("returns clean defaults without removed runtime settings", async () => {
    const store = new DrizzleRuntimeSettingsStore(makeDb() as never);
    const result = await store.get("tenant-1");
    expect(result.redisModeActual).toBe(resolveRedisMode());
    for (const key of REMOVED_RUNTIME_SETTING_KEYS) {
      expect(key in result).toBe(false);
    }
  });

  test("defaults payload capture to metadata-only", async () => {
    const store = new DrizzleRuntimeSettingsStore(makeDb() as never);
    const result = await store.get("tenant-1");
    expect(result.telemetryPayloads).toBe("none");
  });

  test("updates active settings through the upsert shape", async () => {
    const store = new DrizzleRuntimeSettingsStore(makeDb() as never);
    const result = await store.update("tenant-1", { telemetryPayloads: "none" });
    expect(result.telemetryPayloads).toBe("none");
    for (const key of REMOVED_RUNTIME_SETTING_KEYS) {
      expect(key in result).toBe(false);
    }
  });
});
