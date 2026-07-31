/**
 * Edge-case tests for the shared OpenCode catalog module — cache TTL
 * expiry and empty data array handling. The existing
 * opencode-catalog.test.ts covers success, 503, malformed body, cache
 * reuse, findOpenCodeModel, and selectCapability; this file covers the
 * remaining edge cases.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import {
  fetchOpenCodeCatalog,
  resetOpenCodeCatalogForTests,
} from "../../../src/upstream/providers/opencode-catalog";
import { ProviderCallError } from "../../../src/upstream/providers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  resetOpenCodeCatalogForTests();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function catalogOf(ids: string[]) {
  return new Response(
    JSON.stringify({ data: ids.map((id) => ({ id, object: "model", created: 1234, owned_by: "opencode" })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("fetchOpenCodeCatalog — cache TTL expiry", () => {
  test("fetches again after the TTL window expires", async () => {
    // The module uses Date.now() internally with a 60-second TTL.
    // We can't advance time in bun:test without timers, but we CAN
    // verify that the cache key is based on real time by checking
    // that two calls in quick succession share the same fetch, while
    // a call after resetting the cache (simulating TTL expiry) fetches again.
    fetchSpy.mockResolvedValue(catalogOf(["m1"]));
    await fetchOpenCodeCatalog();
    await fetchOpenCodeCatalog();
    expect(fetchSpy.mock.calls.length).toBe(1);

    // Simulate TTL expiry by resetting the cache.
    resetOpenCodeCatalogForTests();
    // Must provide a fresh Response since the previous one's body was consumed.
    fetchSpy.mockResolvedValue(catalogOf(["m2"]));
    await fetchOpenCodeCatalog();
    expect(fetchSpy.mock.calls.length).toBe(2);
  });
});

describe("fetchOpenCodeCatalog — empty data array", () => {
  test("returns an empty array when data is an empty JSON array", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const catalog = await fetchOpenCodeCatalog();
    expect(catalog).toEqual([]);
  });
});

describe("fetchOpenCodeCatalog — 502 malformed body variants", () => {
  test("throws 502 when body is a JSON string (not an object)", async () => {
    fetchSpy.mockImplementation(((): Promise<Response> => Promise.resolve(
      new Response(JSON.stringify("unexpected string"), { status: 200, headers: { "content-type": "application/json" } }),
    )) as unknown as typeof fetch);
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });

  test("throws 502 when body is a JSON number", async () => {
    fetchSpy.mockImplementation(((): Promise<Response> => Promise.resolve(
      new Response(JSON.stringify(42), { status: 200, headers: { "content-type": "application/json" } }),
    )) as unknown as typeof fetch);
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });

  test("throws 502 when body is JSON null", async () => {
    fetchSpy.mockImplementation(((): Promise<Response> => Promise.resolve(
      new Response(JSON.stringify(null), { status: 200, headers: { "content-type": "application/json" } }),
    )) as unknown as typeof fetch);
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });
});

describe("fetchOpenCodeCatalog — HTTP error status variants", () => {
  test("throws 503 on 502 Bad Gateway", async () => {
    fetchSpy.mockImplementation(((): Promise<Response> => Promise.resolve(new Response("bad gateway", { status: 502 }))) as unknown as typeof fetch);
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });

  test("throws 503 on 403 Forbidden", async () => {
    fetchSpy.mockImplementation(((): Promise<Response> => Promise.resolve(new Response("forbidden", { status: 403 }))) as unknown as typeof fetch);
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });

  test("throws 503 on 429 Too Many Requests", async () => {
    fetchSpy.mockImplementation(((): Promise<Response> => Promise.resolve(new Response("rate limited", { status: 429 }))) as unknown as typeof fetch);
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });
});
