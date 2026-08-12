import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRouteAttempt, createRouteAttemptState } from "../../src/application/request/route-attempt";
import type { AccountCandidate, Adapter, ProviderCallError, ProviderOutput, ProviderModelCatalog, ProviderMeta, ProviderCaps, ProxyRequest, RouteCandidate, StreamEvent } from "../../src/application/contracts";
import { getProviderInFlight, resetInFlightForTests } from "../../src/traffic/in-flight";
import type { ProxyRequestDependencies } from "../../src/application/request";

const account: AccountCandidate = {
  id: "account-1",
  providerId: "provider-1",
  credentialKind: "oauth",
  health: null,
  enabled: true,
  quotaAvailable: true,
  modelLocks: null,
};
const metadata: ProviderMeta = { id: "provider-1", displayName: "Provider", protocol: "openai", credentialKind: "oauth" };
const capabilities: ProviderCaps = { surfaces: ["openai-chat"], streaming: true, reasoning: false, toolCalls: false, images: false, mediaGeneration: [], explicitCache: false, promptCacheKey: false };
const models: ProviderModelCatalog = { list: [], get: () => null };
const request: ProxyRequest = {
  model: "model-1",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  stream: false,
  responseFormat: "text",
  reasoning: "default",
  maxOutputTokens: null,
  images: [],
  sourceSurface: "openai-chat",
  signal: new AbortController().signal,
  limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
};

function candidate(id = "route-1"): RouteCandidate {
  return { id, providerId: "provider-1", modelId: "model-1", surface: "openai-chat", health: null, enabled: true, authorized: true, compatible: true };
}

function providerError(message = "adapter failed"): ProviderCallError {
  return { statusCode: 502, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: message, retryAt: null };
}

function dependencies(options: {
  readonly adapterCall: (input: Parameters<Adapter["call"]>[0]) => Promise<ProviderOutput>;
  readonly accountRelease?: (leaseId: string) => Promise<void>;
  readonly networkRelease?: () => Promise<void>;
  readonly networkResult?: ProxyRequestDependencies["network"]["select"] extends (...args: never[]) => infer T ? Awaited<T> : never;
}): ProxyRequestDependencies {
  const adapter: Adapter = { metadata, capabilities, models, resolveTarget: (modelId, surface) => ({ providerId: "provider-1", modelId, upstreamModelId: modelId, surface }), call: options.adapterCall, mapError: (error) => error instanceof Error ? providerError(error.message) : providerError() };
  return {
    providers: { get: () => adapter },
    accounts: {
      select: async () => ({ selection: { accountId: account.id, kind: "oauth", leaseId: "lease-1", secret: "access-token" }, account, reason: "sole" }),
      release: options.accountRelease ?? (async () => {}),
      forceRefresh: async () => ({ accessToken: "access-token", expiresAtMs: null, refreshToken: null, kind: "oauth" }),
    } as unknown as ProxyRequestDependencies["accounts"],
    network: {
      select: async () => options.networkResult === undefined
        ? { selection: { proxyId: null, url: null, release: options.networkRelease ?? (async () => {}) }, mode: "direct", proxyId: null, reason: "direct_forced" }
        : options.networkResult,
    } as unknown as ProxyRequestDependencies["network"],
    telemetry: { start: () => ({ requestId: "request-1", recordSwitch: () => {}, recordFirstToken: () => {}, finish: async () => {} }) },
    resolveRoutes: async () => ({ affinity: { namespace: "trusted_identity", value: "test" }, candidates: [candidate()] }),
    accountCandidates: async () => [account],
  };
}

function createAttempt(deps: ProxyRequestDependencies, signal = request.signal, candidates = [candidate()]) {
  return createRouteAttempt({
    input: { request: { signal, headers: new Headers() }, authorization: { apiKeyId: null, trustedIdentity: "test" } },
    dependencies: deps,
    request: { ...request, signal },
    plan: { affinity: { namespace: "trusted_identity", value: "test" }, candidates },
    capture: null,
    state: createRouteAttemptState(),
  });
}

beforeEach(() => resetInFlightForTests());
afterEach(() => resetInFlightForTests());

describe("route attempt resource lifecycle", () => {
  test("releases credential, network, and provider accounting once on success", async () => {
    let accountReleases = 0;
    let networkReleases = 0;
    const attempt = createAttempt(dependencies({
      adapterCall: async () => ({ mode: "non_stream", body: { ok: true } }),
      accountRelease: async () => { accountReleases += 1; },
      networkRelease: async () => { networkReleases += 1; },
    }));

    await expect(attempt(0)).resolves.toMatchObject({ mode: "non_stream" });
    expect(accountReleases).toBe(1);
    expect(networkReleases).toBe(1);
    expect(getProviderInFlight()).toEqual([]);
  });

  test("preserves adapter error when cleanup fails and still attempts every release", async () => {
    let accountReleases = 0;
    let networkReleases = 0;
    const primary = providerError("primary adapter failure");
    const attempt = createAttempt(dependencies({
      adapterCall: async () => { throw new Error(primary.sanitizedMessage); },
      accountRelease: async () => { accountReleases += 1; throw new Error("secret=cleanup-account"); },
      networkRelease: async () => { networkReleases += 1; throw new Error("token=cleanup-network"); },
    }));

    await expect(attempt(0)).rejects.toMatchObject({ sanitizedMessage: primary.sanitizedMessage });
    expect(accountReleases).toBe(1);
    expect(networkReleases).toBe(1);
    expect(getProviderInFlight()).toEqual([]);
  });

  test("releases each failed attempt before retrying with a fresh candidate", async () => {
    let calls = 0;
    let accountReleases = 0;
    let networkReleases = 0;
    const attempt = createAttempt(dependencies({
      adapterCall: async () => {
        calls += 1;
        if (calls === 1) throw new Error("retryable failure");
        return { mode: "non_stream", body: { ok: true } };
      },
      accountRelease: async () => { accountReleases += 1; },
      networkRelease: async () => { networkReleases += 1; },
    }), request.signal, [candidate("route-1"), candidate("route-2")]);

    await expect(attempt(0)).rejects.toBeDefined();
    await expect(attempt(1)).resolves.toMatchObject({ mode: "non_stream" });
    expect(accountReleases).toBe(2);
    expect(networkReleases).toBe(2);
    expect(getProviderInFlight()).toEqual([]);
  });

  test("holds resources until stream terminal completion", async () => {
    let accountReleases = 0;
    let networkReleases = 0;
    const events: readonly StreamEvent[] = [{ type: "message_start", id: "message-1" }, { type: "message_stop", reason: "completed" }];
    const attempt = createAttempt(dependencies({
      adapterCall: async () => ({ mode: "stream", events: (async function*() { for (const event of events) yield event; })() }),
      accountRelease: async () => { accountReleases += 1; },
      networkRelease: async () => { networkReleases += 1; },
    }));

    const output = await attempt(0);
    expect(accountReleases).toBe(0);
    expect(networkReleases).toBe(0);
    if (output.mode !== "stream") throw new Error("expected stream output");
    const observed = [];
    for await (const event of output.events) observed.push(event.type);
    expect(observed).toEqual(["message_start", "message_stop"]);
    expect(accountReleases).toBe(1);
    expect(networkReleases).toBe(1);
    expect(getProviderInFlight()).toEqual([]);
  });

  test("releases stream resources on consumer cancellation", async () => {
    let accountReleases = 0;
    let networkReleases = 0;
    const never = Promise.withResolvers<void>().promise;
    const attempt = createAttempt(dependencies({
      adapterCall: async () => ({ mode: "stream", events: (async function*() { yield { type: "message_start", id: "message-1" } as const; await never; })() }),
      accountRelease: async () => { accountReleases += 1; },
      networkRelease: async () => { networkReleases += 1; },
    }));
    const output = await attempt(0);
    if (output.mode !== "stream") throw new Error("expected stream output");

    const iterator = output.events[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(accountReleases).toBe(1);
    expect(networkReleases).toBe(1);
    expect(getProviderInFlight()).toEqual([]);
  });

  test("releases a handed-off stream when the client aborts before consumption", async () => {
    let accountReleases = 0;
    let networkReleases = 0;
    const controller = new AbortController();
    const never = Promise.withResolvers<void>().promise;
    const attempt = createAttempt(dependencies({
      adapterCall: async () => ({ mode: "stream", events: (async function*() { await never; })() }),
      accountRelease: async () => { accountReleases += 1; },
      networkRelease: async () => { networkReleases += 1; },
    }), controller.signal);

    const output = await attempt(0);
    controller.abort();
    await Promise.resolve();
    expect(output.mode).toBe("stream");
    expect(accountReleases).toBe(1);
    expect(networkReleases).toBe(1);
    expect(getProviderInFlight()).toEqual([]);
  });

  test("releases a credential when network acquisition is partial", async () => {
    let accountReleases = 0;
    const attempt = createAttempt(dependencies({
      adapterCall: async () => ({ mode: "non_stream", body: { ok: true } }),
      accountRelease: async () => { accountReleases += 1; },
      networkResult: null,
    }));

    await expect(attempt(0)).rejects.toMatchObject({ kind: "network_unavailable" });
    expect(accountReleases).toBe(1);
    expect(getProviderInFlight()).toEqual([]);
  });
});
