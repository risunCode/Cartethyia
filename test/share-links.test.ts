import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShareLink, handleShareRequest } from "../src/console/share";
import { createConfigPersistence, type ConfigPersistence } from "../src/storage/main/config";
import type { RuntimePersistence } from "../src/storage/runtime/runtime";

const configs: ConfigPersistence[] = [];
const runtimes = [{ metadata: { sumKeyTokens: () => ({ dailyUsed: 12, monthlyUsed: 30, allTimeUsed: 44 }) } }] as unknown as RuntimePersistence[];

function makeConfig(): ConfigPersistence {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-share-test-"));
  const config = createConfigPersistence({ dataDir: dir, dbPath: join(dir, "config.sqlite"), runtimeDbPath: join(dir, "runtime.sqlite"), assetDir: join(dir, "assets"), logRetentionDays: 14, assetRetentionDays: 7, maxFlightsPerIp: 15 });
  configs.push(config);
  return config;
}

afterEach(() => {
  while (configs.length > 0) configs.pop()?.close();
});

describe("share links", () => {
  test("monitor data never contains the API key", async () => {
    const config = makeConfig();
    config.apiKeys.create({ id: "key-1", name: "monitor", key: "ck-secret", keyPrefix: "ck-secret" });
    const link = await createShareLink(config, "key-1", "monitor");
    const response = await handleShareRequest(config, runtimes[0]!, new Request(`http://localhost${link.urlPath}/data`));
    const body = await response?.json() as Record<string, unknown>;
    expect(response?.status).toBe(200);
    expect(body.key).toBeUndefined();
    expect(body.dailyUsed).toBe(12);
    expect(body.monthlyUsed).toBe(30);
    expect(body.quotaAvailable).toBe(true);
    expect(body.apiKey).toEqual({ id: "key-1", prefix: "ck-secret", active: true });
    expect(body.notes).toEqual({ title: null, subtitle: null, body: null });
    expect(typeof body.inFlight).toBe("number");
  });

  test("setup data reveals the key once and rejects reuse", async () => {
    const config = makeConfig();
    config.apiKeys.create({ id: "key-1", name: "setup", key: "ck-secret", keyPrefix: "ck-secret" });
    const link = await createShareLink(config, "key-1", "setup");
    const url = `http://localhost${link.urlPath}/data`;
    const first = await handleShareRequest(config, runtimes[0]!, new Request(url));
    const second = await handleShareRequest(config, runtimes[0]!, new Request(url));
    expect(first?.status).toBe(200);
    expect((await first?.json() as { key?: string }).key).toBe("ck-secret");
    expect(second?.status).toBe(410);
  });
});
