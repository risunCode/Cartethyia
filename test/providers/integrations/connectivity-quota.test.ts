import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../../../src/providers/quota/quota-contracts";
import { probeApiKeyConnectivity } from "../../../src/providers/quota/quota-support";
import { fetchCerebrasQuota } from "../../../src/providers/integrations/cerebras";
import { fetchInferhubQuota } from "../../../src/providers/integrations/inferhub";

function mockFetch(status: number): {
  fetcher: FetchLike;
  seenUrl: string[];
  seenInit: RequestInit[];
} {
  const seenUrl: string[] = [];
  const seenInit: RequestInit[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl.push(String(input));
    seenInit.push(init ?? {});
    return new Response("{}", { status });
  }) as unknown as FetchLike;
  return { fetcher, seenUrl, seenInit };
}

describe("probeApiKeyConnectivity", () => {
  test("200 means the key is valid", async () => {
    const { fetcher, seenUrl, seenInit } = mockFetch(200);
    const result = await probeApiKeyConnectivity("inferhub", "sk-test", fetcher);
    expect(seenUrl[0]).toBe("https://api.inferhub.dev/v1/models");
    expect(result).toMatchObject({ source: "inferhub", error: null });
    expect(new Headers(seenInit[0]?.headers).get("user-agent")).toBeNull();
    expect(result.windows).toEqual([]);
  });

  test("401 means the key is revoked", async () => {
    const { fetcher } = mockFetch(401);
    const result = await probeApiKeyConnectivity("cerebras", "bad-key", fetcher);
    expect(result.error).toContain("revoked");
  });

  test("403 means the key is revoked", async () => {
    const { fetcher } = mockFetch(403);
    const result = await probeApiKeyConnectivity("cerebras", "bad-key", fetcher);
    expect(result.error).toContain("revoked");
  });

  test("5xx is an inconclusive transport error, not a credential verdict", async () => {
    const { fetcher } = mockFetch(500);
    const result = await probeApiKeyConnectivity("cerebras", "key", fetcher);
    expect(result.error).toContain("HTTP 500");
    expect(result.error).not.toContain("revoked");
  });

  test("network failure throws for the caller to classify", async () => {
    const fetcher = (async () => {
      throw new Error("fetch failed");
    }) as unknown as FetchLike;
    await expect(probeApiKeyConnectivity("cerebras", "key", fetcher)).rejects.toThrow(
      "Connectivity check failed",
    );
  });
});

describe("provider connectivity fetchers", () => {
  test("cerebras probes its models endpoint", async () => {
    const { fetcher, seenUrl } = mockFetch(200);
    const result = await fetchCerebrasQuota("key", fetcher);
    expect(seenUrl[0]).toBe("https://api.cerebras.ai/v1/models");
    expect(result).toMatchObject({ source: "cerebras", error: null });
  });

  test("inferhub probes its models endpoint", async () => {
    const { fetcher, seenUrl } = mockFetch(200);
    const result = await fetchInferhubQuota("key", fetcher);
    expect(seenUrl[0]).toBe("https://api.inferhub.dev/v1/models");
    expect(result).toMatchObject({ source: "inferhub", error: null });
  });
});
