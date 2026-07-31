/**
 * Unit tests for the shared OpenCode catalog module (src/upstream/providers/opencode-catalog.ts).
 * Covers: successful fetch, 503 upstream error, malformed body shapes, and cache reuse.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import {
  fetchOpenCodeCatalog,
  findOpenCodeModel,
  selectCapability,
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

describe("fetchOpenCodeCatalog — success", () => {
  test("returns parsed model entries", async () => {
    fetchSpy.mockResolvedValueOnce(catalogOf(["gpt-4o", "claude-opus"]));
    const catalog = await fetchOpenCodeCatalog();
    expect(catalog).toHaveLength(2);
    expect(catalog[0]!.id).toBe("gpt-4o");
    expect(catalog[1]!.id).toBe("claude-opus");
  });

  test("filters out entries without an id", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "valid" }, { noId: true }, null, 42] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const catalog = await fetchOpenCodeCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.id).toBe("valid");
  });

  test("returns cached result on second call without fetching again", async () => {
    fetchSpy.mockResolvedValue(catalogOf(["m1"]));
    await fetchOpenCodeCatalog();
    await fetchOpenCodeCatalog();
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

describe("fetchOpenCodeCatalog — upstream error paths", () => {
  test("throws ProviderCallError(503) when upstream returns non-ok status", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("service unavailable", { status: 503 }));
    let caught: unknown;
    try {
      await fetchOpenCodeCatalog();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderCallError);
    expect((caught as ProviderCallError).status).toBe(503);
  });

  test("clears cache on 503 so the next call retries", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(catalogOf(["retry-model"]));
    await fetchOpenCodeCatalog().catch(() => {});
    const catalog = await fetchOpenCodeCatalog();
    expect(catalog[0]!.id).toBe("retry-model");
    expect(fetchSpy.mock.calls.length).toBe(2);
  });

  test("throws ProviderCallError(502) when body is a JSON array (unexpected shape)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });

  test("throws ProviderCallError(502) when data field is missing", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(fetchOpenCodeCatalog()).rejects.toBeInstanceOf(ProviderCallError);
  });
});

describe("findOpenCodeModel", () => {
  const catalog = [{ id: "alpha" }, { id: "beta" }];
  test("returns the matching entry", () => expect(findOpenCodeModel(catalog, "alpha")).toEqual({ id: "alpha" }));
  test("returns undefined for unknown model", () => expect(findOpenCodeModel(catalog, "gamma")).toBeUndefined());
});

describe("selectCapability", () => {
  const entry = { id: "m" };
  test("returns 'chat' when requested capability is 'chat'", () =>
    expect(selectCapability(entry, "chat")).toBe("chat"));
  test("returns undefined when requested capability is 'messages'", () =>
    expect(selectCapability(entry, "messages")).toBeUndefined());
  test("returns undefined when requested capability is 'responses'", () =>
    expect(selectCapability(entry, "responses")).toBeUndefined());
});
