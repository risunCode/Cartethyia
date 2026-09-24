import { afterEach, describe, expect, test } from "bun:test";
import { getCachedModelDiscovery, resetModelDiscoveryCacheForTesting } from "../../../src/providers/operations/model-discovery-cache";
import { resetDeduplicationForTesting } from "../../../src/network/deduplication";
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
  resetModelDiscoveryCacheForTesting();
  resetDeduplicationForTesting();
});

describe("getCachedModelDiscovery", () => {
  test("caches a non-empty result within the TTL", async () => {
    let calls = 0;
    const loader = async (): Promise<readonly ModelDefinition[]> => {
      calls += 1;
      return [model("a")];
    };
    const first = await getCachedModelDiscovery("k", loader);
    const second = await getCachedModelDiscovery("k", loader);
    expect(first?.map((m) => m.modelId)).toEqual(["a"]);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  test("does not cache null or empty results", async () => {
    let calls = 0;
    const loader = async (): Promise<readonly ModelDefinition[] | null> => {
      calls += 1;
      return calls === 1 ? null : calls === 2 ? [] : [model("b")];
    };
    expect(await getCachedModelDiscovery("k", loader)).toBeNull();
    expect(await getCachedModelDiscovery("k", loader)).toEqual([]);
    expect(await getCachedModelDiscovery("k", loader)).toEqual([model("b")]);
    expect(calls).toBe(3);
  });

  test("reloads after the TTL expires", async () => {
    let calls = 0;
    const loader = async (): Promise<readonly ModelDefinition[]> => {
      calls += 1;
      return [model(`m${calls}`)];
    };
    await getCachedModelDiscovery("k", loader, { ttlMs: 0 });
    const second = await getCachedModelDiscovery("k", loader, { ttlMs: 0 });
    expect(second?.map((m) => m.modelId)).toEqual(["m2"]);
    expect(calls).toBe(2);
  });

  test("keeps distinct keys independent", async () => {
    const loaderFor = (id: string) => async (): Promise<readonly ModelDefinition[]> => [model(id)];
    expect((await getCachedModelDiscovery("a", loaderFor("a")))?.map((m) => m.modelId)).toEqual(["a"]);
    expect((await getCachedModelDiscovery("b", loaderFor("b")))?.map((m) => m.modelId)).toEqual(["b"]);
  });
});
