import { describe, expect, test } from "bun:test";
import { runProxyRequest, type ProxyRequestDependencies } from "../../src/application/request";
import type { AccountCandidate, Adapter, ProviderCaps, ProviderCallError, ProviderMeta, ProviderModelCatalog, ProviderOutput, RouteCandidate, TelemetryFinish, TelemetryWriter } from "../../src/application/contracts";
import type { CredentialSelector } from "../../src/application/auth/credentials";

const account: AccountCandidate = { id: "account-1", providerId: "provider-1", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null };
const metadata: ProviderMeta = { id: "provider-1", displayName: "Provider", protocol: "openai", credentialKind: "api_key" };
const capabilities: ProviderCaps = { surfaces: ["openai-chat"], streaming: true, reasoning: false, toolCalls: false, images: false, mediaGeneration: [], explicitCache: false, promptCacheKey: false };
const models: ProviderModelCatalog = { list: [], get: () => null };
const failure: ProviderCallError = { statusCode: 502, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: "upstream failed", retryAt: null };

function candidate(id: string): RouteCandidate {
  return { id, providerId: "provider-1", modelId: id, surface: "openai-chat", health: null, enabled: true, authorized: true, compatible: true };
}

function input(body: Record<string, unknown> = { model: "model-1", messages: [{ role: "user", content: "hello" }] }, signal = new AbortController().signal): Parameters<typeof runProxyRequest>[0] {
  return { request: { requestId: "request-hot", endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers({ "content-type": "application/json" }), body, signal }, authorization: { apiKeyId: null, trustedIdentity: "hot-test" } };
}

function dependencies(options: { candidates?: readonly RouteCandidate[]; output?: ProviderOutput; error?: ProviderCallError; telemetry?: TelemetryFinish[]; calls?: { value: number }; switches?: unknown[]; network?: boolean; accountAvailable?: boolean }): ProxyRequestDependencies {
  const calls = options.calls ?? { value: 0 };
  const adapter: Adapter = {
    metadata,
    capabilities,
    models,
    resolveTarget: (modelId, surface) => ({ providerId: "provider-1", modelId, upstreamModelId: `upstream-${modelId}`, surface }),
    call: async () => {
      calls.value += 1;
      if (options.error !== undefined) throw options.error;
      return options.output ?? { mode: "non_stream", body: { ok: true } };
    },
    mapError: () => options.error ?? failure,
  };
  const telemetry: TelemetryWriter = { start: () => ({ requestId: "request-hot", recordSwitch: () => {}, recordFirstToken: () => {}, finish: async (result) => { options.telemetry?.push(result); } }) };
  const accountSelector = { select: async () => options.accountAvailable === false ? null : { selection: { accountId: account.id, kind: "api_key" as const, leaseId: "lease-hot", secret: "key" }, account, reason: "sole" as const }, release: async () => {}, forceRefresh: async () => ({ accessToken: "token", expiresAtMs: null, refreshToken: null, kind: "oauth" as const }) } as unknown as CredentialSelector;
  return {
    providers: { get: (providerId) => providerId === "provider-1" ? adapter : undefined },
    accounts: accountSelector,
    network: { select: async () => options.network === false ? null : { selection: { proxyId: null, url: null, release: async () => {} }, mode: "direct", proxyId: null, reason: "direct_forced" } } as unknown as ProxyRequestDependencies["network"],
    telemetry,
    resolveRoutes: async () => ({ affinity: { namespace: "trusted_identity", value: "hot-test" }, candidates: options.candidates ?? [candidate("model-1")] }),
    accountCandidates: async () => [account],
    maxAttempts: 2,
    onRouteSwitch: async (event) => { options.switches?.push(event); },
  };
}

describe("request orchestration hot paths", () => {
  test("returns normalized non-stream response and completes telemetry", async () => {
    const finishes: TelemetryFinish[] = [];
    const response = await runProxyRequest(input(), dependencies({ telemetry: finishes }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mode: "json", value: { ok: true } });
    expect(finishes[0]).toMatchObject({ statusCode: 200, mode: "non_stream", providerId: "provider-1", model: "model-1" });
  });

  test("returns model-not-found when route policy leaves no candidate", async () => {
    const finishes: TelemetryFinish[] = [];
    const response = await runProxyRequest(input(), dependencies({ candidates: [], telemetry: finishes }));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "model_not_found" } } });
    expect(finishes[0]).toMatchObject({ statusCode: 404, errorKind: "model_not_found" });
  });

  test("returns network failure without calling provider", async () => {
    const calls = { value: 0 };
    const response = await runProxyRequest(input(), dependencies({ calls, network: false }));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "provider_unavailable" } } });
    expect(calls.value).toBe(0);
  });

  test("returns provider failure and records stable sanitized error telemetry", async () => {
    const finishes: TelemetryFinish[] = [];
    const response = await runProxyRequest(input(), dependencies({ error: failure, telemetry: finishes }));
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "provider_protocol_error" } } });
    expect(finishes[0]).toMatchObject({ statusCode: 502, errorKind: "provider_protocol_error" });
  });

  test("returns credential failure before provider call", async () => {
    const calls = { value: 0 };
    const response = await runProxyRequest(input(), dependencies({ calls, accountAvailable: false }));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ mode: "json", value: { error: { code: "credential_unavailable" } } });
    expect(calls.value).toBe(0);
  });
  test("consumes stream output, records first token, usage, and terminal telemetry", async () => {
    const finishes: TelemetryFinish[] = [];
    const output: ProviderOutput = {
      mode: "stream",
      events: (async function* () {
        yield { type: "message_start", id: "message-hot" };
        yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, source: "provider" } };
        yield { type: "text_delta", text: "hello" };
        yield { type: "message_stop", reason: "completed" };
      })(),
    };
    const response = await runProxyRequest(input({ model: "model-1", messages: [{ role: "user", content: "hello" }], stream: true }), dependencies({ output, telemetry: finishes }));
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("stream");
    if (response.body.mode !== "stream") throw new Error("expected stream response");
    const events = [];
    for await (const event of response.body.events) events.push(event);
    expect(events).toHaveLength(4);
    expect(events[2]).toMatchObject({ type: "text_delta", text: "hello" });
    expect(finishes[0]).toMatchObject({ statusCode: 200, mode: "stream", usage: { outputTokens: 2 } });
  });
});
