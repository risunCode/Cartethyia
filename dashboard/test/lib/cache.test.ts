import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { apiCache, getCacheKey } from "../../src/lib/cache";

describe("APICache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    apiCache.clear();
    vi.useRealTimers();
  });

  test("returns null for keys that were never stored", () => {
    expect(apiCache.get("/api/dashboard/summary")).toBeNull();
  });

  test("returns stored data while the entry is fresh", () => {
    apiCache.set("/api/dashboard/usage", { requests: 12 });

    expect(apiCache.get("/api/dashboard/usage")).toEqual({ requests: 12 });
  });

  test.each([
    ["/api/dashboard/summary", 5_000],
    ["/api/dashboard/usage", 30_000],
    ["/api/dashboard/providers", 60_000],
    ["/api/dashboard/quota", 30_000],
    ["/api/dashboard/console/history", 60_000],
    ["/api/dashboard/settings", 300_000],
    ["/api/share", 60_000],
  ])("expires %s %d ms after it was stored", (endpoint, ttl) => {
    apiCache.set(endpoint, { fresh: true });

    vi.advanceTimersByTime(ttl);
    expect(apiCache.get(endpoint)).toEqual({ fresh: true });

    vi.advanceTimersByTime(1);
    expect(apiCache.get(endpoint)).toBeNull();
  });

  test("matches endpoint prefixes when resolving the configured TTL", () => {
    apiCache.set("/api/dashboard/summary?window=1h", { ok: true });

    vi.advanceTimersByTime(5_000);
    expect(apiCache.get("/api/dashboard/summary?window=1h")).toEqual({ ok: true });

    vi.advanceTimersByTime(1);
    expect(apiCache.get("/api/dashboard/summary?window=1h")).toBeNull();
  });

  test("falls back to a one minute TTL for unconfigured endpoints", () => {
    apiCache.set("/api/unknown-endpoint", { ok: true });

    vi.advanceTimersByTime(60_000);
    expect(apiCache.get("/api/unknown-endpoint")).toEqual({ ok: true });

    vi.advanceTimersByTime(1);
    expect(apiCache.get("/api/unknown-endpoint")).toBeNull();
  });

  test("lets an explicit TTL override the endpoint configuration", () => {
    apiCache.set("/api/dashboard/settings", { ok: true }, 1_000);

    vi.advanceTimersByTime(1_000);
    expect(apiCache.get("/api/dashboard/settings")).toEqual({ ok: true });

    vi.advanceTimersByTime(1);
    expect(apiCache.get("/api/dashboard/settings")).toBeNull();
  });

  test("drops the entry from the cache once it expires", () => {
    apiCache.set("/api/dashboard/summary", { ok: true });
    expect(apiCache.size()).toBe(1);

    vi.advanceTimersByTime(5_001);
    expect(apiCache.get("/api/dashboard/summary")).toBeNull();
    expect(apiCache.size()).toBe(0);
  });

  test("invalidates a single key without touching neighbours", () => {
    apiCache.set("/api/dashboard/usage", { a: 1 });
    apiCache.set("/api/dashboard/providers", { b: 2 });

    apiCache.invalidate("/api/dashboard/usage");

    expect(apiCache.get("/api/dashboard/usage")).toBeNull();
    expect(apiCache.get("/api/dashboard/providers")).toEqual({ b: 2 });
    expect(apiCache.size()).toBe(1);
  });

  test("invalidates every key matching a pattern", () => {
    apiCache.set("/api/dashboard/usage?from=t1", { a: 1 });
    apiCache.set("/api/dashboard/usage?from=t2", { b: 2 });
    apiCache.set("/api/dashboard/providers", { c: 3 });

    apiCache.invalidatePattern("^/api/dashboard/usage");

    expect(apiCache.get("/api/dashboard/usage?from=t1")).toBeNull();
    expect(apiCache.get("/api/dashboard/usage?from=t2")).toBeNull();
    expect(apiCache.get("/api/dashboard/providers")).toEqual({ c: 3 });
  });

  test("clear removes every entry", () => {
    apiCache.set("/api/dashboard/summary", { a: 1 });
    apiCache.set("/api/share", { b: 2 });

    apiCache.clear();

    expect(apiCache.size()).toBe(0);
    expect(apiCache.get("/api/share")).toBeNull();
  });

  test("reports size, age, and TTL per entry for monitoring", () => {
    apiCache.set("/api/dashboard/quota", { limits: [] });
    vi.advanceTimersByTime(1_500);

    const stats = apiCache.getStats();
    expect(stats.size).toBe(1);
    expect(stats.entries).toHaveLength(1);
    expect(stats.entries[0]).toMatchObject({ key: "/api/dashboard/quota", age: 1_500, ttl: 30_000 });
  });
});

describe("getCacheKey", () => {
  test("returns the url untouched when no params are supplied", () => {
    expect(getCacheKey("/api/dashboard/summary")).toBe("/api/dashboard/summary");
  });

  test("returns the url for an empty params object", () => {
    expect(getCacheKey("/api/dashboard/summary", {})).toBe("/api/dashboard/summary");
  });

  test("appends encoded params to the url", () => {
    expect(getCacheKey("/console/logs", { from: "2026-01-01T00:00:00Z", limit: 500 })).toBe(
      "/console/logs?from=2026-01-01T00%3A00%3A00Z&limit=500",
    );
  });

  test("stringifies numeric and boolean params", () => {
    expect(getCacheKey("/console/logs", { limit: 100, cached: true })).toBe("/console/logs?limit=100&cached=true");
  });
});
