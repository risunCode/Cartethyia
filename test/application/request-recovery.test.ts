import { describe, expect, test } from "bun:test";
import { runProxyRequest, type ProxyRequestDependencies } from "../../src/application/request";
import type { AccountCandidate, Adapter, ProviderCallError, ProviderOutput, ProviderModelCatalog, ProviderMeta, ProviderCaps, RouteCandidate, TelemetryFinish, TelemetryWriter } from "../../src/application/contracts";
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

const account2: AccountCandidate = { ...account, id: "oauth-account-2" };

const accountRateLimit: ProviderCallError = {
  statusCode: 429,
  kind: "provider_rate_limited",
  retryable: true,
  routeScope: "account",
  source: "upstream",
  sanitizedMessage: "provider rate limit",
  retryAt: null,
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

const capabilityFailure: ProviderCallError = {
  statusCode: 400,
  kind: "capability_unsupported",
  retryable: false,
  routeScope: "provider",
  source: "upstream",
  sanitizedMessage: "search capability unavailable",
  retryAt: null,
};

const metadata: ProviderMeta = { id: "codex", displayName: "Codex", protocol: "openai", credentialKind: "oauth" };
const capabilities: ProviderCaps = { surfaces: ["openai-chat"], streaming: false, reasoning: false, toolCalls: false, images: false, mediaGeneration: [], explicitCache: false, promptCacheKey: false };
const models: ProviderModelCatalog = { list: [], get: () => null };

function routeCandidate(id: string, modelId: string): RouteCandidate {
  return { id, providerId: "codex", modelId, surface: "openai-chat", health: null, enabled: true, authorized: true, compatible: true };
}

function makeDependencies(options: {
  readonly failures: number;
  readonly candidates: readonly RouteCandidate[];
  readonly seenTargets: string[];
  readonly forceRefreshCalls: { value: number };
  readonly switches: RouteSwitchLog[];
  readonly failure?: ProviderCallError;
  readonly accounts?: readonly AccountCandidate[];
  readonly webSearch?: boolean;
  readonly finishes?: TelemetryFinish[];
}): ProxyRequestDependencies {
  let calls = 0;
  const adapter: Adapter = {
    metadata,
    capabilities,
    models,
    resolveTarget: (modelId, surface) => ({ providerId: "codex", modelId, upstreamModelId: modelId, surface }),
    call: async (input): Promise<ProviderOutput> => {
      calls += 1;
      options.seenTargets.push(input.target.modelId);
      if (calls <= options.failures) throw options.failure ?? authFailure;
      return { mode: "non_stream", body: { ok: true, model: input.target.modelId } };
    },
    mapError: () => options.failure ?? authFailure,
  };
  let selections = 0;
  const fakeAccounts = {
    select: async () => {
      const candidates = options.accounts ?? [account];
      const chosen = candidates[Math.min(selections++, candidates.length - 1)] ?? account;
      return { selection: { accountId: chosen.id, kind: "oauth" as const, leaseId: `selection-lease-${chosen.id}`, secret: "access-token" }, account: chosen, reason: "sole" as const };
    },
    release: async () => {},
    forceRefresh: async () => { options.forceRefreshCalls.value += 1; },
  } as unknown as CredentialSelector;
  const telemetry: TelemetryWriter = {
    start: () => ({ requestId: "request-1", recordSwitch: () => {}, recordFirstToken: () => {}, finish: async (result) => { if (options.finishes !== undefined) options.finishes.push(result); } }),
  };
  return {
    providers: { get: (providerId) => providerId === "codex" ? adapter : undefined },
    accounts: fakeAccounts,
    network: { select: async () => ({ selection: { proxyId: null, url: null, release: async () => {} }, mode: "direct", proxyId: null, reason: "direct_forced" }) } as unknown as ProxyRequestDependencies["network"],
    telemetry,
    resolveRoutes: async () => ({
      affinity: { namespace: "trusted_identity", value: "test" },
      candidates: options.candidates,
      ...(options.webSearch ? { webSearch: true, maxAttempts: options.candidates.length } : {}),
    }),
    accountCandidates: async () => options.accounts ?? [account],
    maxAttempts: 3,
    onRouteSwitch: async (event) => { options.switches.push(event); },
  };
}

type RouteSwitchLog = { readonly previousRouteId: string | null; readonly replacementRouteId: string | null; readonly scope: "account" | "proxy" };

function input(webSearch = false): Parameters<typeof runProxyRequest>[0] {
  return {
    request: {
      requestId: "request-1",
      endpoint: "/v1/chat/completions",
      surface: "openai-chat",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        model: "client-model",
        messages: [{ role: "user", content: "hello" }],
        ...(webSearch ? { tools: [{ type: "function", function: { name: "web_search", parameters: {} } }] } : {}),
      },
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
  test("retries the same route to fail over after an account-scoped rate limit", async () => {
    const seenTargets: string[] = [];
    const forceRefreshCalls = { value: 0 };
    const switches: RouteSwitchLog[] = [];
    const dependencies = makeDependencies({
      failures: 1,
      failure: accountRateLimit,
      accounts: [account, account2],
      candidates: [routeCandidate("route-0", "model-0")],
      seenTargets,
      forceRefreshCalls,
      switches,
    });

    const response = await runProxyRequest(input(), dependencies);

    expect(response.status).toBe(200);
    expect(seenTargets).toEqual(["model-0", "model-0"]);
    expect(switches).toHaveLength(0);
  });
  test("fails over a web-search capability error before returning to the client", async () => {
    const seenTargets: string[] = [];
    const forceRefreshCalls = { value: 0 };
    const switches: RouteSwitchLog[] = [];
    const finishes: TelemetryFinish[] = [];
    const dependencies = makeDependencies({
      failures: 1,
      failure: capabilityFailure,
      webSearch: true,
      candidates: [routeCandidate("route-0", "model-0"), routeCandidate("route-1", "model-1")],
      seenTargets,
      forceRefreshCalls,
      switches,
      finishes,
    });

    const response = await runProxyRequest(input(true), dependencies);

    expect(response.status).toBe(200);
    expect(seenTargets).toEqual(["model-0", "model-1"]);
    expect(response.body).toEqual({ mode: "json", value: { ok: true, model: "model-1" } });
    expect(finishes[0]?.routing?.webSearchFallbacks).toEqual([{ previousRouteId: "route-0", replacementRouteId: "route-1", reason: "capability_unsupported" }]);
  });
});
