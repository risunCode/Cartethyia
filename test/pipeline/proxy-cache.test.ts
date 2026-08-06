import { describe, expect, test } from "bun:test";
import { ProxyPool, type ProxyConfig } from "../../src/traffic";

const proxy = (id: string): ProxyConfig => ({
  id,
  url: `http://${id}.example.test:8080`,
  enabled: true,
  maxConcurrency: 8,
  priority: 0,
  weight: 100,
  excludedProviderIds: [],
});

describe("proxy pool configuration cache", () => {
  test("shares one config read across hot-path lookups and invalidates cleanly", async () => {
    let reads = 0;
    let rows = [proxy("a")];
    const store = {
      async listProxies() { reads += 1; return rows; },
      async getProxy(id: string) { return rows.find((candidate) => candidate.id === id); },
    };
    const pool = new ProxyPool(store);

    expect(await pool.enabledFor("openai")).toHaveLength(1);
    expect(await pool.get("a")).toMatchObject({ id: "a" });
    const slot = await pool.acquireSlot("a");
    expect(slot).not.toBeNull();
    await slot?.release();
    expect(reads).toBe(1);

    rows = [proxy("b")];
    pool.invalidate();
    expect(await pool.get("b")).toMatchObject({ id: "b" });
    expect(await pool.get("a")).toBeUndefined();
    expect(reads).toBe(2);
  });
});
