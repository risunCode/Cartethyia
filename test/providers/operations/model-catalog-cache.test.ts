import { afterEach, describe, expect, test } from "bun:test";
import { getCachedModels, resetModelCatalogCacheForTesting } from "../../../src/providers/operations/model-catalog-cache";
import type { ModelDefinition } from "../../../src/providers/provider-registry";

function model(id: string): ModelDefinition {
  return {
    modelId: id,
    wireFamily: "chat",
    endpointPath: "/chat/completions",
    contextLimit: 1_000,
    outputLimit: 100,
    modalities: { input: ["text"], output: ["text"] },
    reasoning: false,
    toolCall: true,
    webSearch: false,
    cost: { input: null, output: null, pricing_model: "unknown" },
  };
}

afterEach(() => {
  resetModelCatalogCacheForTesting();
});

describe("getCachedModels", () => {
  test("loads a provider catalog once and reuses the promise", async () => {
    let calls = 0;
    const loader = async (): Promise<readonly ModelDefinition[]> => {
      calls += 1;
      return [model("m")];
    };
    const first = await getCachedModels("p", loader);
    const second = await getCachedModels("p", loader);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  test("shares a single in-flight load across concurrent callers", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async (): Promise<readonly ModelDefinition[]> => {
      calls += 1;
      await gate;
      return [model("m")];
    };
    const first = getCachedModels("p", loader);
    const second = getCachedModels("p", loader);
    expect(calls).toBe(1);
    release();
    expect(await first).toBe(await second);
  });

  test("evicts a failed load so a later call retries", async () => {
    let calls = 0;
    const loader = async (): Promise<readonly ModelDefinition[]> => {
      calls += 1;
      if (calls === 1) throw new Error("import failed");
      return [model("m")];
    };
    await expect(getCachedModels("p", loader)).rejects.toThrow("import failed");
    expect((await getCachedModels("p", loader)).map((m) => m.modelId)).toEqual(["m"]);
    expect(calls).toBe(2);
  });

  test("caches each provider independently", async () => {
    const loaderFor = (id: string) => async (): Promise<readonly ModelDefinition[]> => [model(id)];
    const a = await getCachedModels("a", loaderFor("a"));
    const b = await getCachedModels("b", loaderFor("b"));
    expect(a.map((m) => m.modelId)).toEqual(["a"]);
    expect(b.map((m) => m.modelId)).toEqual(["b"]);
  });

  test("evicts the least-recently-used provider at the configured bound", async () => {
    const calls = new Map<string, number>();
    const loaderFor = (id: string) => async (): Promise<readonly ModelDefinition[]> => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return [model(id)];
    };
    await getCachedModels("a", loaderFor("a"), 2);
    await getCachedModels("b", loaderFor("b"), 2);
    // Touch "a" so "b" becomes the LRU entry.
    await getCachedModels("a", loaderFor("a"), 2);
    // Inserting "c" at the bound evicts "b", not the hot "a".
    await getCachedModels("c", loaderFor("c"), 2);
    await getCachedModels("b", loaderFor("b"), 2);
    expect(calls.get("a")).toBe(1);
    expect(calls.get("b")).toBe(2);
    expect(calls.get("c")).toBe(1);
  });

  test("bounds the cache at the default of 64 providers", async () => {
    const calls = new Map<string, number>();
    const loaderFor = (id: string) => async (): Promise<readonly ModelDefinition[]> => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return [model(id)];
    };
    for (let i = 0; i < 64; i += 1) await getCachedModels(`p${i}`, loaderFor(`p${i}`));
    // The 65th insert evicts the oldest (p0).
    await getCachedModels("p64", loaderFor("p64"));
    await getCachedModels("p0", loaderFor("p0"));
    expect(calls.get("p0")).toBe(2);
    expect(calls.get("p63")).toBe(1);
    expect(calls.get("p64")).toBe(1);
  });
});
