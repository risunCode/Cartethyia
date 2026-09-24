import { describe, expect, test } from "bun:test";
import {
  fetchClineQuota,
  markClineApiKeyCredential,
} from "../../../../src/providers/integrations/cline/cline-quota";
import type { FetchLike } from "../../../../src/providers/quota/quota-contracts";
import { refreshAccountQuota } from "../../../../src/console/quota/quota-refresh";
import type { QuotaRefreshDeps } from "../../../../src/console/quota/quota-refresh";

function fetcherFor(routes: Record<string, { status: number; body: unknown }>): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as FetchLike;
}

describe("Cline API-key account test", () => {
  test("marked api keys probe /models instead of the OAuth users/me surface", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "a" }] }), { status: 200 });
      }
      return new Response("forbidden", { status: 401 });
    }) as FetchLike;
    const result = await fetchClineQuota(markClineApiKeyCredential("secret-key"), fetcher);
    expect(result.error).toBeNull();
    expect(seen).toEqual(["https://api.cline.bot/api/v1/models"]);
  });

  test("revoked api keys report invalid instead of dispatchable", async () => {
    const result = await fetchClineQuota(
      markClineApiKeyCredential("dead-key"),
      fetcherFor({ "https://api.cline.bot/api/v1/models": { status: 401, body: {} } }),
    );
    expect(result.error).toBe("API key is invalid or revoked.");
  });

  test("oauth credentials keep the users/me quota path", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (String(input).endsWith("/users/me")) return new Response(JSON.stringify({ id: "u-1" }), { status: 200 });
      if (String(input).endsWith("/users/me/plan")) return new Response(JSON.stringify({ plan: { displayName: "Pro" } }), { status: 200 });
      if (String(input).endsWith("/users/me/plan/usage-limits"))
        return new Response(JSON.stringify({ limits: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as FetchLike;
    const result = await fetchClineQuota("oauth-token", fetcher);
    expect(result.error).toBeNull();
    expect(seen.some((url) => url.endsWith("/users/me"))).toBe(true);
    expect(seen.some((url) => url.endsWith("/models"))).toBe(false);
  });

  test("shared refresh marks api keys but leaves OAuth credentials raw", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "a" }] }), { status: 200 });
      }
      if (String(input).endsWith("/users/me")) return new Response(JSON.stringify({ id: "u-1" }), { status: 200 });
      if (String(input).endsWith("/users/me/plan")) return new Response(JSON.stringify({ plan: { displayName: "Pro" } }), { status: 200 });
      if (String(input).endsWith("/users/me/plan/usage-limits")) return new Response(JSON.stringify({ limits: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as FetchLike;
    const deps: QuotaRefreshDeps = {
      db: {} as never,
      redis: {} as never,
      providerRegistry: { resolveQuotaCollector: () => Promise.resolve(fetchClineQuota) } as never,
      resolveCredential: () => Promise.resolve("stored-secret"),
      markApiKeyCredential: (providerId: string, credential: string) =>
        providerId === "cline" ? markClineApiKeyCredential(credential) : credential,
    };
    await refreshAccountQuota(
      deps,
      { accountId: "key-acct", providerId: "cline", tenantId: null, credentialKind: "api_key" },
      fetcher,
    );
    expect(seen).toEqual(["https://api.cline.bot/api/v1/models"]);
    seen.length = 0;
    await refreshAccountQuota(
      deps,
      { accountId: "oauth-acct", providerId: "cline", tenantId: null, credentialKind: "oauth" },
      fetcher,
    );
    expect(seen.some((url) => url.endsWith("/users/me"))).toBe(true);
    expect(seen.some((url) => url.endsWith("/models"))).toBe(false);
  });
});
