import { describe, expect, test } from "bun:test";
import { TtlCache } from "../../src/console/db/ttl-cache";

describe("TtlCache", () => {
  test("evicts the oldest entry at the configured bound", () => {
    const cache = new TtlCache<string, number>(60_000, 2);
    let loads = 0;
    const load = (value: number) => () => {
      loads += 1;
      return value;
    };

    expect(cache.get("a", load(1))).toBe(1);
    expect(cache.get("b", load(2))).toBe(2);
    expect(cache.get("a", load(10))).toBe(1);
    expect(cache.get("c", load(3))).toBe(3);
    expect(cache.get("b", load(20))).toBe(2);
    expect(cache.get("a", load(10))).toBe(10);
    expect(loads).toBe(4);
  });

  test("bounds negative lookup entries just like successful values", () => {
    const cache = new TtlCache<string, string | null>(60_000, 2);
    let loads = 0;
    const load = () => {
      loads += 1;
      return null;
    };

    cache.get("invalid-1", load);
    cache.get("invalid-2", load);
    cache.get("invalid-3", load);
    cache.get("invalid-1", load);

    expect(loads).toBe(4);
  });
});
