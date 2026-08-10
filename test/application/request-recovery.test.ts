import { describe, expect, test } from "bun:test";
import { runProxyRequest, type ProxyRequestDependencies } from "../../src/application/request";
import type { AccountCandidate, Adapter, ProviderCallError, ProviderOutput, ProviderModelCatalog, ProviderMeta, ProviderCaps, RouteCandidate, TelemetryWriter } from "../../src/application/contracts";
import type { CredentialSelector } from "../../src/application/auth/credentials";

const account: AccountCandidate = {
  id: "oauth-account-1",
  providerId: "codex",
  credentialKind: "oauth",
  health: null,
  enabled: true,
  quotaAvailable: true,
  modelLocks: null,
};

const authFailure: ProviderCallError = {
  statusCode: 401,
  kind: "authentication_failed",
  retryable: false,
  routeScope: "account",
  source: "upstream",
  sanitizedMessage: "upstream rejected access token",
  retryAt: null,
};

const metadata: ProviderMeta = { id: "codex", displayName: "Codex", protocol: "openai", credentialKind: "oauth" };
const capabilities: ProviderCaps = { surfaces: ["openai-chat"], streaming: false, reasoning: false, toolCalls: false, images: false, explicitCache: false, promptCacheKey: false };
const models: ProviderModelCatalog = { list: [], get: () => null };

function routeCandidate(id: string, modelId: string): RouteCandidate {
  return { id, providerId: "codex", modelId, surface: "openai-chat", health: null, enabled: true, authorized: true, compatible: true };
}

function makeDependencies(options: { readonly failures: number; readonly candidates: readonly RouteCandidate[]; readonly seenTargets: string[]; readonly forceRefreshCalls: { value: number }; readonly switches: RouteSwitchLog[] }): ProxyRequestDependencies {
  let calls = 0;
  const adapter: Adapter = {
    metadata,
    capabilities,
    models,
    resolveTarget: (modelId, surface) => ({ providerId: "codex", modelId, upstreamModelId: modelId, surface }),
    call: async (input): Promise<ProviderOutput> => {
      calls += 1;
      options.seenTargets.push(input.target.modelId);
      if (calls <= options.failures) throw authFailure;
      return { mode: "non_stream", body: { ok: true, model: input.target.modelId } };
    },
    mapError: () => authFailure,
  };
  const fakeAccounts = {
    select: async () => ({ selection: { accountId: account.id, kind: "oauth" as const, leaseId: "selection-lease", secret: "access-token" }, account, reason: "sole" as const }),
    release: async () => {},
    forceRefresh: async () => { options.forceRefreshCalls.value += 1; },
  } as unknown as CredentialSelector;
  const telemetry: TelemetryWriter = {
    start: () => ({ requestId: "request-1", recordSwitch: () => {}, recordFirstToken: () => {}, finish: async () => {} }),
  };
  return {
    providers: { get: (providerId) => providerId === "codex" ? adapter : undefined },
    accounts: fakeAccounts,
    network: { select: async () => ({ selection: { proxyId: null, url: null, release: async () => {} }, mode: "direct", proxyId: null, reason: "direct_forced" }) } as unknown as ProxyRequestDependencies["network"],
    telemetry,
    resolveRoutes: async () => ({ affinity: { namespace: "trusted_identity", value: "test" }, candidates: options.candidates }),
    accountCandidates: async () => [account],
    maxAttempts: 3,
    onRouteSwitch: async (event) => { options.switches.push(event); },
  };
}

type RouteSwitchLog = { readonly previousRouteId: string | null; readonly replacementRouteId: string | null; readonly scope: "account" | "proxy" };

function input(): Parameters<typeof runProxyRequest>[0] {
  return {
    request: {
      requestId: "request-1",
      endpoint: "/v1/chat/completions",
      surface: "openai-chat",
      headers: new Headers({ "content-type": "application/json" }),
      body: { model: "client-model", messages: [{ role: "user", content: "hello" }] },
      signal: new AbortController().signal,
    },
    authorization: { apiKeyId: null, trustedIdentity: "test", apiKey: undefined },
  };
}

describe("request OAuth recovery", () => {
  test("refreshes and retries the same route before changing candidates", async () => {
    const seenTargets: string[] = [];
    const forceRefreshCalls = { value: 0 };
    const switches: RouteSwitchLog[] = [];
    const dependencies = makeDependencies({ failures: 1, candidates: [routeCandidate("route-0", "model-0")], seenTargets, forceRefreshCalls, switches });

    const response = await runProxyRequest(input(), dependencies);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mode: "json", value: { ok: true, model: "model-0" } });
    expect(seenTargets).toEqual(["model-0", "model-0"]);
    expect(forceRefreshCalls.value).toBe(1);
    expect(switches).toHaveLength(0);
  });

  test("rotates to the next route after the reactive retry still fails auth", async () => {
    const seenTargets: string[] = [];
    const forceRefreshCalls = { value: 0 };
    const switches: RouteSwitchLog[] = [];
    const dependencies = makeDependencies({ failures: 2, candidates: [routeCandidate("route-0", "model-0"), routeCandidate("route-1", "model-1")], seenTargets, forceRefreshCalls, switches });

    const response = await runProxyRequest(input(), dependencies);

    expect(response.status).toBe(200);
    expect(seenTargets).toEqual(["model-0", "model-0", "model-1"]);
    expect(forceRefreshCalls.value).toBe(1);
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ scope: "account", previousRouteId: "route-0", replacementRouteId: "route-1", reason: "authentication_failed" });
  });
});
