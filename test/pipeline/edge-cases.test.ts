import { describe, expect, test, vi } from "bun:test";
import { createCleanupStack, type ProviderOutput } from "../../src/domain/contracts";
import {
  classifyImageReference,
  normalizeRequest,
  readBoundedJson,
  type NormalizeInput,
} from "../../src/domain/protocols";
import { recoverCall } from "../../src/app/recovery";
import { runProxyRequest, type ProxyRequestDependencies } from "../../src/app/request";
import { ProxyService } from "../../src/console/services";
import type { ProviderAdapter, ProviderCallError, StreamEvent } from "../../src/domain/contracts";
import { AbortCoordinator } from "../../src/providers/shared";
import { ApiKeyAdmission } from "../../src/traffic/admission";
import {
  NetworkSelector,
  ProxyHealthManager,
  ProxyPool,
  ProxySlotManager,
  type ProxyConfig,
} from "../../src/traffic";
import { MemoryProxyHealthStore } from "../traffic/helpers";

const limits = {
  maxBodyBytes: 1_024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function normalizeInput(signal = new AbortController().signal): NormalizeInput {
  return { signal, limits };
}

function proxyConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id: "proxy-a",
    url: "http://127.0.0.1:8080",
    enabled: true,
    maxConcurrency: 1,
    priority: 0,
    weight: 100,
    excludedProviderIds: [],
    ...overrides,
  };
}

function retryableFailure(): {
  readonly statusCode: number;
  readonly kind: "provider_unavailable";
  readonly retryable: true;
  readonly routeScope: "provider";
  readonly source: "internal";
  readonly sanitizedMessage: string;
  readonly retryAt: null;
} {
  return {
    statusCode: 503,
    kind: "provider_unavailable",
    retryable: true,
    routeScope: "provider",
    source: "internal",
    sanitizedMessage: "temporary failure",
    retryAt: null,
  };
}

function output(): ProviderOutput {
  return { mode: "non_stream", body: { id: "bench", object: "chat.completion" } };
}

function fakeAdapter(call: ProviderAdapter["call"]): ProviderAdapter {
  const capabilities = { surfaces: ["openai-chat"] as const, streaming: true, reasoning: false, toolCalls: false, images: false, explicitCache: false, promptCacheKey: false };
  return {
    metadata: { id: "fake", displayName: "Fake", protocol: "openai", credentialKind: "none" },
    capabilities,
    models: { list: [{ id: "model", displayName: "Model", capabilities }], get: (modelId) => modelId === "model" ? { id: "model", displayName: "Model", capabilities } : null },
    resolveTarget: (modelId, surface) => ({ providerId: "fake", modelId, upstreamModelId: modelId, surface }),
    call,
    countTokens: async () => ({ tokens: null, source: "unknown" }),
    mapError: (): ProviderCallError => ({ statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "provider", source: "internal", sanitizedMessage: "Upstream provider unavailable", retryAt: null }),
  };
}

function requestDependencies(adapter: ProviderAdapter, telemetryFinishes: Array<Record<string, unknown>>, releases: { account: number; network: number }): ProxyRequestDependencies {
  return {
    providers: { get: (providerId) => providerId === "fake" ? adapter : undefined },
    accounts: {} as ProxyRequestDependencies["accounts"],
    network: { select: async () => ({ proxyId: null, selection: { proxyId: null, url: null, release: async () => { releases.network += 1; } } }) } as unknown as ProxyRequestDependencies["network"],
    telemetry: { start: () => ({ requestId: "test-request", recordSwitch: () => {}, recordFirstToken: () => {}, finish: async (result) => { telemetryFinishes.push(result as unknown as Record<string, unknown>); } }) },
    resolveRoutes: async () => ({ affinity: { namespace: "api_key", value: "key-1" }, candidates: [{ id: "route-1", providerId: "fake", modelId: "model", surface: "openai-chat", accountIds: [], proxyIds: [], health: null, enabled: true, authorized: true, quotaAvailable: true, compatible: true }] }),
    accountCandidates: async () => [],
    maxAttempts: 1,
  };
}

describe("edge contracts and bounded load primitives", () => {
  test("completes a non-stream request and records terminal telemetry", async () => {
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = fakeAdapter(async () => output());
    const lifecycleLogs: Array<{ readonly event: string; readonly providerId: string | null; readonly status: number | null }> = [];
    const dependencies = {
      ...requestDependencies(adapter, telemetryFinishes, releases),
      onRequestLog: (event) => { lifecycleLogs.push({ event: event.event, providerId: event.providerId, status: event.status }); },
    } satisfies ProxyRequestDependencies;
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, dependencies);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mode: "json", value: { id: "bench", object: "chat.completion" } });
    expect(telemetryFinishes).toHaveLength(1);
    expect(telemetryFinishes[0]).toMatchObject({ statusCode: 200, errorKind: null, providerId: "fake", model: "model", mode: "non_stream" });
    expect(lifecycleLogs).toEqual([
      expect.objectContaining({ event: "incoming", providerId: "fake", status: null }),
      expect.objectContaining({ event: "complete", providerId: "fake", status: 200 }),
    ]);
  });

  test("returns a sanitized provider failure and releases the network selection", async () => {
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = fakeAdapter(async () => { throw new Error("secret upstream body should not escape"); });
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, requestDependencies(adapter, telemetryFinishes, releases));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "provider_unavailable" } } });
    expect(JSON.stringify(response.body)).not.toContain("secret upstream body");
    expect(releases.network).toBe(1);
    expect(telemetryFinishes[0]).toMatchObject({ statusCode: 503, errorKind: "provider_unavailable" });
  });

  test("fails over to the next route and releases each network selection", async () => {
    let calls = 0;
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = fakeAdapter(async () => {
      calls += 1;
      if (calls === 1) throw new Error("first route failed");
      return output();
    });
    const base = requestDependencies(adapter, telemetryFinishes, releases);
    const dependencies: ProxyRequestDependencies = {
      ...base,
      maxAttempts: 2,
      resolveRoutes: async () => ({ affinity: { namespace: "api_key", value: "key-1" }, candidates: [
        { id: "route-1", providerId: "fake", modelId: "model", surface: "openai-chat", accountIds: [], proxyIds: [], health: null, enabled: true, authorized: true, quotaAvailable: true, compatible: true },
        { id: "route-2", providerId: "fake", modelId: "model", surface: "openai-chat", accountIds: [], proxyIds: [], health: null, enabled: true, authorized: true, quotaAvailable: true, compatible: true },
      ] }),
    };
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, dependencies);
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(releases.network).toBe(2);
    expect(telemetryFinishes[0]).toMatchObject({ statusCode: 200, providerId: "fake", errorKind: null });
  });

  test("does not call a provider when no outbound network path is available", async () => {
    let calls = 0;
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = fakeAdapter(async () => { calls += 1; return output(); });
    const base = requestDependencies(adapter, telemetryFinishes, releases);
    const dependencies: ProxyRequestDependencies = { ...base, network: { select: async () => null } as unknown as ProxyRequestDependencies["network"] };
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, dependencies);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "network_unavailable" } } });
    expect(calls).toBe(0);
  });

  test("releases a credential lease when the provider call fails", async () => {
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = { ...fakeAdapter(async () => { throw new Error("credential route failed"); }), metadata: { id: "fake", displayName: "Fake", protocol: "openai" as const, credentialKind: "api_key" as const } };
    const base = requestDependencies(adapter, telemetryFinishes, releases);
    const dependencies: ProxyRequestDependencies = {
      ...base,
      accounts: {
        select: async () => ({ selection: { accountId: "account-1", kind: "api_key", leaseId: "lease-1", secret: "secret" }, route: null }),
        release: async () => { releases.account += 1; },
      } as unknown as ProxyRequestDependencies["accounts"],
      accountCandidates: async () => [{ id: "account-1", providerId: "fake", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null }],
    };
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, dependencies);
    expect(response.status).toBe(503);
    expect(releases.account).toBe(1);
    expect(releases.network).toBe(1);
  });

  test("does not call a provider after the client signal is already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const dependencies = requestDependencies(fakeAdapter(async () => { calls += 1; return output(); }), telemetryFinishes, releases);
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: controller.signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, dependencies);
    expect(response.status).toBe(499);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "client_aborted" } } });
    expect(calls).toBe(0);
    expect(telemetryFinishes[0]).toMatchObject({ statusCode: 0, errorKind: null });
  });

  test("enforces API-key concurrency and releases admission after completion", async () => {
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const key = {
      id: "key-1", name: "test", keyPrefix: "test", active: true, rateLimitRpm: null, dailyTokenLimit: null, monthlyTokenLimit: null,
      oneTimeTokenLimit: null, oneTimeTokensUsed: 0, maxConcurrentRequests: 1, providerAllowlist: null, modelAllowlist: null,
      modelDenylist: null, lastUsedAt: null, createdAt: new Date().toISOString(), revokedAt: null,
    } as const;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const adapter = fakeAdapter(async () => {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await blocked;
      }
      return output();
    });
    const base = requestDependencies(adapter, telemetryFinishes, releases);
    const dependencies: ProxyRequestDependencies = {
      ...base,
      admission: new ApiKeyAdmission({ sumOneTimeTokensUsed: () => 0, consumeOneTimeTokens: () => {} } as never),
    };
    const input = {
      request: { endpoint: "/v1/chat/completions" as const, surface: "openai-chat" as const, headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null, apiKey: key },
    };
    const first = runProxyRequest(input, dependencies);
    await started;
    const second = await runProxyRequest(input, dependencies);
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ mode: "json", value: { error: { code: "concurrency_exceeded" } } });
    unblock();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(calls).toBe(1);
    const third = await runProxyRequest(input, dependencies);
    expect(third.status).toBe(200);
  });

  test("does not call a provider when route ACL removes every candidate", async () => {
    let calls = 0;
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = fakeAdapter(async () => { calls += 1; return output(); });
    const dependencies = requestDependencies(adapter, telemetryFinishes, releases);
    (dependencies as unknown as { resolveRoutes: ProxyRequestDependencies["resolveRoutes"] }).resolveRoutes = async () => ({ affinity: { namespace: "api_key", value: "key-1" }, candidates: [{ id: "route-1", providerId: "fake", modelId: "model", surface: "openai-chat", accountIds: [], proxyIds: [], health: null, enabled: true, authorized: true, quotaAvailable: true, compatible: true }] });
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null, providerAllowlist: ["other-provider"] },
    }, dependencies);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "model_not_found" } } });
    expect(calls).toBe(0);
    expect(telemetryFinishes[0]).toMatchObject({ statusCode: 404, errorKind: "model_not_found" });
  });

  test("releases network resources after consuming a streaming response", async () => {
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = fakeAdapter(async () => ({ mode: "stream", events: (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "message_start", id: "stream-1" };
      yield { type: "text_delta", text: "hello" };
      yield { type: "message_stop", reason: "completed" };
    })() }));
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", stream: true, messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, requestDependencies(adapter, telemetryFinishes, releases));
    expect(response.body.mode).toBe("stream");
    if (response.body.mode !== "stream") throw new Error("expected stream response");
    for await (const _event of response.body.events) {}
    expect(releases.network).toBe(1);
    expect(telemetryFinishes[0]).toMatchObject({ statusCode: 200, errorKind: null, mode: "stream" });
  });

  test("surfaces a truncated stream and releases its network selection", async () => {
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const adapter = fakeAdapter(async () => ({ mode: "stream", events: (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "message_start", id: "truncated-e2e" };
    })() }));
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "model", stream: true, messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, requestDependencies(adapter, telemetryFinishes, releases));
    expect(response.body.mode).toBe("stream");
    if (response.body.mode !== "stream") throw new Error("expected stream response");
    const events = response.body.events;
    await expect((async () => { for await (const _event of events) {} })()).rejects.toMatchObject({ kind: "stream_truncated" });
    expect(releases.network).toBe(1);
    expect(telemetryFinishes[0]).toMatchObject({ statusCode: 200, mode: "stream" });
  });

  test("returns model_not_found when routing produces no eligible candidates", async () => {
    const telemetryFinishes: Array<Record<string, unknown>> = [];
    const releases = { account: 0, network: 0 };
    const dependencies = requestDependencies(fakeAdapter(async () => output()), telemetryFinishes, releases);
    (dependencies as unknown as { resolveRoutes: ProxyRequestDependencies["resolveRoutes"] }).resolveRoutes = async () => ({ affinity: { namespace: "api_key", value: "key-1" }, candidates: [] });
    const response = await runProxyRequest({
      request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers(), body: { model: "missing", messages: [{ role: "user", content: "hello" }] }, signal: new AbortController().signal },
      authorization: { apiKeyId: "key-1", trustedIdentity: null },
    }, dependencies);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "model_not_found" } } });
  });

  test("rejects oversized and malformed request bodies before JSON parsing", async () => {
    const oversized = await readBoundedJson(new Request("http://test", { method: "POST", body: "{}" }), 1);
    expect(oversized).toEqual({ ok: false, reason: "too_large" });

    const malformed = await readBoundedJson(new Request("http://test", { method: "POST", body: "{" }), 32);
    expect(malformed).toEqual({ ok: false, reason: "invalid" });
  });

  test("rejects invalid model and private image targets", () => {
    const invalid = normalizeRequest("/v1/chat/completions", { model: "", messages: [] }, normalizeInput());
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.kind).toBe("invalid_request");

    const image = classifyImageReference("http://127.0.0.1/private.png", "messages[0].content[0]");
    expect(image.ok).toBe(false);
  });

  test("retries only bounded failures and releases cleanup once", async () => {
    const cleanup = createCleanupStack();
    let releases = 0;
    cleanup.add({ release: async () => { releases += 1; } });
    const attempts: number[] = [];
    const result = await recoverCall({
      attempt: async (index) => {
        attempts.push(index);
        if (index === 0) throw retryableFailure();
        return output();
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
    });
    expect(result.mode).toBe("non_stream");
    expect(attempts).toEqual([0, 1]);
    expect(releases).toBe(1);
    await cleanup.run();
    expect(releases).toBe(1);
  });

  test("does not invoke an attempt after client cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const cleanup = createCleanupStack();
    let attempts = 0;
    await expect(recoverCall({
      attempt: async () => {
        attempts += 1;
        return output();
      },
      maxAttempts: 3,
      signal: controller.signal,
      cleanup,
    })).rejects.toMatchObject({ kind: "client_aborted" });
    expect(attempts).toBe(0);
  });

  test("surfaces truncated streams and releases deferred cleanup exactly once", async () => {
    const cleanup = createCleanupStack();
    let releases = 0;
    cleanup.add({ release: async () => { releases += 1; } });
    let attempts = 0;
    async function* truncated(): AsyncGenerator<import("../../src/domain/contracts").StreamEvent> {
      yield { type: "message_start", id: "truncated" };
    }
    const recovered = await recoverCall({
      attempt: async () => {
        attempts += 1;
        return { mode: "stream", events: truncated() };
      },
      maxAttempts: 3,
      signal: new AbortController().signal,
      cleanup,
    });
    await expect((async () => {
      if (recovered.mode !== "stream") throw new Error("expected stream output");
      for await (const _event of recovered.events) {}
    })()).rejects.toMatchObject({ kind: "stream_truncated" });
    expect(attempts).toBe(1);
    expect(releases).toBe(1);
    await cleanup.run();
    expect(releases).toBe(1);
  });

  test("attributes timer cancellation separately from caller cancellation", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AbortCoordinator(new AbortController().signal, { totalTimeoutMs: 5 });
      vi.advanceTimersByTime(5);
      expect(coordinator.signal.aborted).toBe(true);
      expect(coordinator.causeOf()).toBe("total_timeout");
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("runs proxy canary through HTTP proxy and persists last error", async () => {
    let status = 204;
    const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status }) });
    const row = { id: "proxy-test", protocol: "http" as const, host: "127.0.0.1", port: server.port, username: null, isRelay: false };
    let savedHealth: Record<string, unknown> | null = null;
    let savedTest: Record<string, unknown> | null = null;
    const repo = {
      async get() { return row; },
      async credential() { return { password: null }; },
      async recordTest(_id: string, result: Record<string, unknown>) { savedTest = result; },
      async setHealth(_id: string, health: Record<string, unknown>) { savedHealth = health; },
    } as unknown as ConstructorParameters<typeof ProxyService>[0];
    const service = new ProxyService(repo, {} as ConstructorParameters<typeof ProxyService>[1], {} as ConstructorParameters<typeof ProxyService>[2]);
    try {
      const success = await service.test(row.id);
      expect(success).toMatchObject({ ok: true, statusCode: 204 });
      expect(savedTest).toMatchObject({ ok: true, latencyMs: expect.any(Number), error: null });
      expect(savedHealth).toMatchObject({ status: "healthy", failureKind: null });

      status = 502;
      const failure = await service.test(row.id);
      expect(failure).toMatchObject({ ok: false, statusCode: 502, error: "Canary request returned HTTP 502" });
      expect(savedTest).toMatchObject({ ok: false, latencyMs: null, error: "Canary request returned HTTP 502" });
      expect(savedHealth).toMatchObject({ status: "error", failureKind: "manual_test", sanitizedMessage: "Canary request returned HTTP 502" });
    } finally {
      server.stop(true);
    }
  });

  test("enforces proxy slot bounds and idempotent release", async () => {
    const slots = new ProxySlotManager();
    const first = slots.tryAcquire("proxy-a", 1);
    expect(first).not.toBeNull();
    expect(slots.tryAcquire("proxy-a", 1)).toBeNull();
    await first?.release();
    await first?.release();
    expect(slots.activeCount("proxy-a")).toBe(0);
  });

  test("fails open to direct when a proxy is busy and honors proxy-only mode", async () => {
    const config = {
      async getProxy(id: string) { return id === "proxy-a" ? proxyConfig() : undefined; },
      async listProxies() { return [proxyConfig()]; },
    };
    const pool = new ProxyPool(config);
    const health = new ProxyHealthManager(new MemoryProxyHealthStore(), { nowMs: () => 1_000 });
    const selector = new NetworkSelector(pool, health);
    const first = await selector.select({ providerId: "openai" });
    expect(first?.mode).toBe("proxy");
    const fallback = await selector.select({ providerId: "openai" });
    expect(fallback?.reason).toBe("proxy_busy_direct");
    const required = await selector.select({ providerId: "openai", allowDirectFallback: false });
    expect(required).toBeNull();
    await first?.selection.release();
  });

  test("distributes concurrent work across bounded proxy slots", async () => {
    const configs = [proxyConfig({ id: "proxy-a", maxConcurrency: 2 }), proxyConfig({ id: "proxy-b", maxConcurrency: 2 })];
    const config = {
      async getProxy(id: string) { return configs.find((proxy) => proxy.id === id); },
      async listProxies() { return configs; },
    };
    const selector = new NetworkSelector(new ProxyPool(config), new ProxyHealthManager(new MemoryProxyHealthStore()));
    const selections = await Promise.all([1, 2, 3, 4].map(() => selector.select({ providerId: "openai" })));
    const proxyIds = selections.map((entry) => entry?.proxyId).filter((id): id is string => id !== null && id !== undefined);
    expect([...proxyIds].sort()).toEqual(["proxy-a", "proxy-a", "proxy-b", "proxy-b"]);
    await Promise.all(selections.map((entry) => entry?.selection.release()));
  });

  test("keeps target-user affinity and enforces target-concurrent caps", async () => {
    const configs = [proxyConfig({ id: "proxy-a", maxConcurrency: 2 }), proxyConfig({ id: "proxy-b", maxConcurrency: 2 })];
    const config = {
      async getProxy(id: string) { return configs.find((proxy) => proxy.id === id); },
      async listProxies() { return configs; },
    };
    const health = new ProxyHealthManager(new MemoryProxyHealthStore());
    const affinitySelector = new NetworkSelector(new ProxyPool(config), health, () => ({ preset: "target-user", targetConcurrent: 0 }));
    const first = await affinitySelector.select({ providerId: "openai", affinityKey: "api-key-1" });
    const second = await affinitySelector.select({ providerId: "openai", affinityKey: "api-key-1" });
    expect(first?.proxyId).toBe(second?.proxyId);
    await first?.selection.release();
    await second?.selection.release();

    const cappedSelector = new NetworkSelector(new ProxyPool(config), health, () => ({ preset: "target-concurrent", targetConcurrent: 1 }));
    const capped = await Promise.all([1, 2, 3].map(() => cappedSelector.select({ providerId: "openai", allowDirectFallback: false })));
    expect(capped.filter((entry) => entry !== null)).toHaveLength(2);
    expect(capped.filter((entry) => entry === null)).toHaveLength(1);
    await Promise.all(capped.map((entry) => entry?.selection.release()));
  });

  test("falls back when health is cooling down and bypasses excluded providers", async () => {
    const config = {
      async getProxy(id: string) { return id === "proxy-a" ? proxyConfig() : undefined; },
      async listProxies() { return [proxyConfig()]; },
    };
    const health = new ProxyHealthManager(new MemoryProxyHealthStore(), { nowMs: () => 1_000 });
    // T2 transient errors (provider_unavailable) no longer trigger cooldown —
    // the proxy stays usable as "error" status. Use a rate-limit error instead
    // to test the cooling_down path.
    await health.recordFailure("proxy-a", {
      statusCode: 429,
      kind: "provider_rate_limited" as const,
      retryable: true,
      routeScope: "provider" as const,
      source: "upstream" as const,
      sanitizedMessage: "rate limit exceeded",
      retryAt: null,
    });
    const selector = new NetworkSelector(new ProxyPool(config), health);
    const unhealthy = await selector.select({ providerId: "openai", nowMs: 1_000 });
    expect(unhealthy?.reason).toBe("proxy_unhealthy_direct");

    const excludedConfig = {
      async getProxy(id: string) { return id === "proxy-a" ? proxyConfig({ excludedProviderIds: ["openai"] }) : undefined; },
      async listProxies() { return [proxyConfig({ excludedProviderIds: ["openai"] })]; },
    };
    const excluded = await new NetworkSelector(new ProxyPool(excludedConfig), health).select({ providerId: "openai" });
    expect(excluded?.reason).toBe("proxy_disabled_direct");
  });
});
