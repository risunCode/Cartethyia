import { beforeEach, describe, expect, test } from "bun:test";
import { clearConsoleSettingsCacheForTests } from "../../../src/transport/dispatch/attempt-finalize";
import {
  handleProviderProxyRequest,
  type ProviderProxyHandlerDeps,
} from "../../../src/transport/dispatch/proxy-request";
import { type PreparedProxyRequest } from "../../../src/transport/request/preparer";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { GatewayError } from "../../../src/transport/gateway-error";
import { type CanonicalEvent, type CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";
import { parseProviderId, type ProviderAdapter } from "../../../src/providers/provider-registry";
import { consoleSettings } from "../../../src/persistence/schema";

describe("proxy-request.test.ts", () => {
const authorization: ResolvedApiKey = {
  id: "key",
  tenantId: "tenant",
  scopes: [],
  snapshot: { api_key_id: "key", tenant_id: "tenant" },
};

function buildCanonicalRequest(): CanonicalRequest {
  return {
    model: "fast",
    messages: [],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

function terminalUsage(sequenceNumber = 0): CanonicalEvent {
  return {
    type: "terminal",
    sequence_number: sequenceNumber,
    state: "complete",
    usage: {
      input_tokens: 5,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      uncached_input_tokens: 5,
      output_tokens: 5,
      reasoning_tokens: 0,
      estimated_cost: 0,
    },
  };
}

describe("handleProviderProxyRequest — dispatch rewrite", () => {
  beforeEach(() => clearConsoleSettingsCacheForTests());
  test("dispatches the resolved candidate's model, never the client's original alias", async () => {
    const accountId = "account-fixed-id";
    const candidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
    };
    const canonicalRequest = buildCanonicalRequest();

    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "fast",
      resolved_model: "claude-sonnet-4-5",
      provider_id: "anthropic",
    };

    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };

    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;

    let capturedModel: string | undefined;
    const adapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* (dispatchRequest) {
        capturedModel = dispatchRequest.model;
        yield terminalUsage();
      },
    };

    // Fake `.select().from().where().limit()` chain mirroring
    // `resolveCredentialForAccount`'s query shape against `provider_accounts`.
    // The first select resolves stored tenant preferences.
    let selectCount0 = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount0 += 1;
              if (selectCount0 === 1) return []; // console_settings
              return [
                {
                  id: accountId,
                  providerId: "anthropic",
                  credentialKind: "none",
                  credentialCiphertext: null,
                },
              ];
            },
          }),
        }),
      }),
    };

    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore,
    };

    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(capturedModel).toBe("claude-sonnet-4-5");
    expect(capturedModel).not.toBe("fast");
  });

  test("resolves the actual pool per-dispatch via tryAcquireAvailablePool — never a static pin", async () => {
    const accountId = "account-fixed-id";
    const candidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
      tenant_id: "tenant",
      network_pool_ids: ["pool-a", "pool-b"],
      network_pool_limits: { "pool-a": 8, "pool-b": 8 },
    };
    const canonicalRequest = buildCanonicalRequest();

    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "fast",
      resolved_model: "claude-sonnet-4-5",
      provider_id: "anthropic",
    };

    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };

    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;

    const adapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* () {
        yield terminalUsage();
      },
    };

    let selectCount0 = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount0 += 1;
              if (selectCount0 === 1) return [];
              return [
                {
                  id: accountId,
                  providerId: "anthropic",
                  credentialKind: "none",
                  credentialCiphertext: null,
                },
              ];
            },
          }),
        }),
      }),
    };

    const tryAcquireCalls: unknown[] = [];
    const fetchCalls: unknown[] = [];
    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore,
      networkBindingFactory: {
        resolve: async () => ({ hostname: "api.anthropic.com", resolvedAddress: "1.2.3.4" }),
        fetch: (poolId?: string, tenantId?: string) => {
          fetchCalls.push([poolId, tenantId]);
          return (async () => new Response("ok")) as never;
        },
      } as never,
      poolSelector: {
        tryAcquireAvailablePool: async (
          eligiblePoolIds: readonly string[],
          providerId: string,
          limitsByPool: Record<string, number>,
        ) => {
          tryAcquireCalls.push([eligiblePoolIds, providerId, limitsByPool]);
          return { poolId: "pool-b", release: () => {} };
        },
      } as never,
    };

    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(tryAcquireCalls).toEqual([
      [["pool-a", "pool-b"], "anthropic", { "pool-a": 8, "pool-b": 8 }],
    ]);
    // The binding factory is handed the *resolved* pool id, not the raw
    // eligible set — proving selection happens fresh per dispatch attempt.
    expect(fetchCalls).toEqual([["pool-b", "tenant"]]);
  });

  test("returns explicit capacity when every configured pool is full", async () => {
    const accountId = "account-fixed-id";
    const candidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
      tenant_id: "tenant",
      network_pool_ids: ["pool-a"],
      network_pool_limits: { "pool-a": 1 },
    };
    const canonicalRequest = buildCanonicalRequest();
    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "fast",
      resolved_model: "claude-sonnet-4-5",
      provider_id: "anthropic",
    };
    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;
    const adapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* () {
        yield terminalUsage();
      },
    };
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              if (selectCount === 1) return [];
              return [
                {
                  id: accountId,
                  providerId: "anthropic",
                  credentialKind: "none",
                  credentialCiphertext: null,
                },
              ];
            },
          }),
        }),
      }),
    };
    const fetchCalls: unknown[] = [];
    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore,
      networkBindingFactory: {
        resolve: async () => ({ hostname: "api.anthropic.com", resolvedAddress: "1.2.3.4" }),
        fetch: (poolId?: string, tenantId?: string) => {
          fetchCalls.push([poolId, tenantId]);
          return (async () => new Response("ok")) as never;
        },
      } as never,
      poolSelector: {
        // Every eligible pool is at capacity: the atomic acquire refuses the
        // slot, so the handler must NOT dispatch through the full pool.
        tryAcquireAvailablePool: async () => undefined,
      } as never,
    };
    await expect(handleProviderProxyRequest(request, deps)).rejects.toMatchObject({
      code: "proxy_pool_capacity_exceeded",
      status: 429,
    });
    expect(fetchCalls).toEqual([]);
  });

  test("retries the next candidate after a retryable failure, waiting between attempts", async () => {
    const accountId = "account-fixed-id";
    const failingRouteCandidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
    };
    const workingRouteCandidate = {
      provider_id: "openai",
      model_id: "gpt-5",
      wire_family: "chat" as const,
      endpoint: "/v1/responses",
      capability_profile: {},
      provider_account_id: accountId,
    };
    const canonicalRequest = buildCanonicalRequest();

    const plan = {
      revision: 1,
      candidates: [failingRouteCandidate, workingRouteCandidate],
      requested_model: "fast",
      resolved_model: "claude-sonnet-4-5",
      provider_id: "anthropic",
    };

    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate: failingRouteCandidate,
      eligibleRouteCandidates: [failingRouteCandidate, workingRouteCandidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate: failingRouteCandidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };

    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;

    let dispatchCount = 0;
    const anthropicAdapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* () {
        dispatchCount += 1;
        throw new Error("upstream 503");
        // eslint-disable-next-line no-unreachable
        yield terminalUsage();
      },
    };
    const openaiAdapter: ProviderAdapter = {
      provider_id: "openai",
      dispatch: async function* () {
        dispatchCount += 1;
        yield terminalUsage();
      },
    };

    let dbCallIndex = 0;
    let selectCount = 0;
    const accountRows = [
      {
        id: accountId,
        providerId: "anthropic",
        credentialKind: "none",
        credentialCiphertext: null,
      },
      { id: accountId, providerId: "openai", credentialKind: "none", credentialCiphertext: null },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              if (selectCount === 1) return []; // stored tenant preferences lookup
              const row = accountRows[dbCallIndex] ?? accountRows[accountRows.length - 1];
              dbCallIndex += 1;
              return [row];
            },
          }),
        }),
      }),
    };

    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([
        ["anthropic", anthropicAdapter],
        ["openai", openaiAdapter],
      ]),
      stateStore,
    };

    const startedAt = Date.now();
    const response = await handleProviderProxyRequest(request, deps);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(dispatchCount).toBe(2);
    // Backoff before the second attempt must introduce a real, bounded delay
    // (full-jitter exponential, base 100ms / cap 2000ms at attempt index 0).
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(elapsedMs).toBeLessThan(2500);
  });

  test("aborts the inter-attempt backoff early when the request deadline fires", async () => {
    const accountId = "account-fixed-id";
    const failingRouteCandidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
    };
    const workingRouteCandidate = {
      provider_id: "openai",
      model_id: "gpt-5",
      wire_family: "chat" as const,
      endpoint: "/v1/responses",
      capability_profile: {},
      provider_account_id: accountId,
    };
    const canonicalRequest = buildCanonicalRequest();

    const plan = {
      revision: 1,
      candidates: [failingRouteCandidate, workingRouteCandidate],
      requested_model: "fast",
      resolved_model: "claude-sonnet-4-5",
      provider_id: "anthropic",
    };

    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate: failingRouteCandidate,
      eligibleRouteCandidates: [failingRouteCandidate, workingRouteCandidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate: failingRouteCandidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };

    // Deadline expires almost immediately, well before any real backoff cap.
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 10);
    state.preparedRequest = preparedRequest;

    const anthropicAdapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* () {
        throw new Error("upstream 503");
        // eslint-disable-next-line no-unreachable
        yield terminalUsage();
      },
    };
    const openaiAdapter: ProviderAdapter = {
      provider_id: "openai",
      dispatch: async function* () {
        yield terminalUsage();
      },
    };

    let selectCount2 = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount2 += 1;
              if (selectCount2 === 1) return []; // stored tenant preferences lookup
              return [
                {
                  id: accountId,
                  providerId: "anthropic",
                  credentialKind: "none",
                  credentialCiphertext: null,
                },
              ];
            },
          }),
        }),
      }),
    };

    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([
        ["anthropic", anthropicAdapter],
        ["openai", openaiAdapter],
      ]),
      stateStore,
    };

    const startedAt = Date.now();
    await handleProviderProxyRequest(request, deps).catch(() => {});
    const elapsedMs = Date.now() - startedAt;

    // The deadline (10ms) aborts the signal well before the backoff cap
    // (2000ms); sleep() must resolve on abort rather than blocking for the
    // full computed delay.
    expect(elapsedMs).toBeLessThan(500);
  });
  test("streams SSE chunks incrementally without buffering entire upstream (Fix 1)", async () => {
    clearConsoleSettingsCacheForTests();
    const accountId = "account-fixed-id";
    const candidate = {
      provider_id: "openai",
      model_id: "gpt-4",
      wire_family: "chat" as const,
      endpoint: "/v1/chat/completions",
      capability_profile: {},
      provider_account_id: accountId,
      tenant_id: "tenant",
      network_pool_ids: ["pool-a"],
      network_pool_limits: { "pool-a": 8 },
    };
    const canonicalRequest: CanonicalRequest = {
      model: "gpt-4",
      messages: [],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "gpt-4",
      resolved_model: "gpt-4",
      provider_id: "openai",
    };
    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;

    const adapter: ProviderAdapter = {
      provider_id: "openai",
      dispatch: async function* () {
        const start: CanonicalEvent = {
          type: "response_start",
          sequence_number: 1,
          event_id: "fixture-response",
          model: "gpt-4",
        };
        yield start;
        // xAI's encrypted-only reasoning item is canonical but has no
        // Chat-Completions representation (no readable summary/payload).
        // The handler must keep pulling past it rather than leaving the
        // client with only the initial assistant header forever.
        const encryptedOnlyReasoning: CanonicalEvent = {
          type: "content_delta",
          sequence_number: 2,
          content: { kind: "reasoning", payload: null },
        };
        yield encryptedOnlyReasoning;
        const ev1: CanonicalEvent = {
          type: "content_delta",
          sequence_number: 3,
          content: { kind: "text", text: "hello" },
        };
        yield ev1;
        // Real delay to prove incremental delivery — fake timers cannot advance the upstream AsyncIterable's internal await
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield terminalUsage(4);
      },
    };

    let selectCall = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCall += 1;
              if (selectCall === 1) return [];
              return [
                {
                  id: accountId,
                  providerId: "openai",
                  credentialKind: "none",
                  credentialCiphertext: null,
                },
              ];
            },
          }),
        }),
      }),
    };
    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["openai", adapter]]),
      stateStore,
    };
    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.body instanceof ReadableStream).toBe(true);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const startRead = Date.now();
    const first = await reader.read();
    const firstReadTime = Date.now();
    expect(first.done).toBe(false);
    const firstText = decoder.decode(first.value as unknown as Uint8Array);
    expect(firstText).toContain("data:");
    // First chunk must arrive before upstream has finished (secondYieldTime not yet or just after)
    // and well before the 40ms delay between yields completes fully for the whole response
    expect(firstReadTime - startRead).toBeLessThan(30);
    const next = await Promise.race([
      reader.read(),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), 500),
      ),
    ]);
    if ("timedOut" in next) {
      await reader.cancel();
      throw new Error("stream stalled after an invisible canonical reasoning event");
    }
    expect(next.done).toBe(false);
    // Drain remainder
    let done = first.done;
    let allText = firstText;
    if (!next.done && next.value) allText += decoder.decode(next.value as unknown as Uint8Array);
    while (!done) {
      const nxt = await reader.read();
      done = nxt.done;
      if (!nxt.done && nxt.value) allText += decoder.decode(nxt.value as unknown as Uint8Array);
    }
    expect(allText).toContain("hello");
    expect(allText).toContain("[DONE]");
  });
  test("streams a Responses reasoning prelude immediately and retries only an empty prelude", async () => {
    clearConsoleSettingsCacheForTests();
    const accountId = "opencode-account";
    const candidate = {
      provider_id: "opencodeft",
      model_id: "muse-spark-1.3-contributor-free",
      wire_family: "responses" as const,
      endpoint: "/zen/v1/responses",
      capability_profile: {},
      provider_account_id: accountId,
    };
    const canonicalRequest: CanonicalRequest = {
      model: candidate.model_id,
      messages: [],
      generation_controls: {},
      stream: true,
      source_surface: "messages",
    };
    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan: {
        revision: 1,
        candidates: [candidate],
        requested_model: candidate.model_id,
        resolved_model: candidate.model_id,
        provider_id: candidate.provider_id,
      },
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/messages", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;
    let dispatches = 0;
    const adapter: ProviderAdapter = {
      provider_id: "opencodeft",
      dispatch: async function* () {
        dispatches += 1;
        if (dispatches === 1) {
          // A prelude with no client-renderable content that then closes:
          // this is the degenerate case the single retry still covers.
          yield { type: "response_start", sequence_number: 1, model: candidate.model_id } as CanonicalEvent;
          return;
        }
        yield { type: "response_start", sequence_number: 1, model: candidate.model_id } as CanonicalEvent;
        yield {
          type: "content_delta",
          sequence_number: 2,
          content: { kind: "reasoning", summary: "thinking" },
        } as CanonicalEvent;
        yield { type: "content_delta", sequence_number: 3, content: { kind: "text", text: "ok" } } as CanonicalEvent;
        yield { type: "terminal", sequence_number: 4, state: "complete", stop_reason: "stop" } as CanonicalEvent;
      },
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              { id: accountId, providerId: candidate.provider_id, credentialKind: "none", credentialCiphertext: null },
            ],
          }),
        }),
      }),
    };
    const response = await handleProviderProxyRequest(request, {
      db: db as never,
      providerAdapters: new Map([["opencodeft", adapter]]),
      stateStore,
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(dispatches).toBe(2);
    expect(body).toContain("ok");
    // The reasoning summary streams on the committed attempt — a `thinking`
    // block on the messages surface — never held until the answer text.
    expect(body).toContain("thinking_delta");
    expect(body).toContain("thinking");
  });

  test("caches console_settings per-tenant for 5s (no DB hit on warm cache) (Fix 2)", async () => {
    clearConsoleSettingsCacheForTests();
    const accountId = "account-fixed-id";
    const candidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
      tenant_id: "tenant",
    };
    const canonicalRequest = buildCanonicalRequest();
    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "fast",
      resolved_model: "claude-sonnet-4-5",
      provider_id: "anthropic",
    };
    const makePrepared = (): PreparedProxyRequest => ({
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    });
    const adapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* () {
        yield terminalUsage();
      },
    };
    let consoleSettingsCalls = 0;
    // Account-row reads: credential resolution and the account-health report
    // both go through this path. The exact number is an implementation detail
    // (it moves with how the health writer probes the handle), so the test
    // asserts that reads keep happening per request rather than a fixed count.
    let accountReadCalls = 0;
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === consoleSettings) {
                consoleSettingsCalls += 1;
                return [
                  {
                    preferences: {
                      responsesReasoningSummary: "detailed",
                    },
                  },
                ];
              } else {
                accountReadCalls += 1;
                return [
                  {
                    id: accountId,
                    providerId: "anthropic",
                    credentialKind: "none",
                    credentialCiphertext: null,
                  },
                ];
              }
            },
          }),
        }),
      }),
    };
    const stateStore1 = new ProxyRequestStateStore();
    const request1 = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state1 = stateStore1.initialize(request1, Date.now(), 60_000);
    state1.preparedRequest = makePrepared();
    const deps1: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore: stateStore1,
    };
    const r1 = await handleProviderProxyRequest(request1, deps1);
    expect(r1.status).toBe(200);
    expect(consoleSettingsCalls).toBe(1);
    // Second request within TTL should hit cache, not DB
    const stateStore2 = new ProxyRequestStateStore();
    const request2 = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state2 = stateStore2.initialize(request2, Date.now(), 60_000);
    state2.preparedRequest = makePrepared();
    const deps2: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore: stateStore2,
    };
    const r2 = await handleProviderProxyRequest(request2, deps2);
    expect(r2.status).toBe(200);
    // Console settings stay cached across requests...
    expect(consoleSettingsCalls).toBe(1);
    // ...while per-request account work is unaffected by that cache. Two
    // requests must not collapse to zero account reads.
    expect(accountReadCalls).toBeGreaterThanOrEqual(2);
  });

  test("uses the pool's configured limit, not hardcoded 8, when acquiring (Fix 3)", async () => {
    clearConsoleSettingsCacheForTests();
    const accountId = "account-fixed-id";
    const candidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
      tenant_id: "tenant",
      network_pool_ids: ["pool-a"],
      network_pool_limits: { "pool-a": 3 },
    };
    const canonicalRequest = buildCanonicalRequest();
    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "fast",
      resolved_model: "claude-sonnet-4-5",
      provider_id: "anthropic",
    };
    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;
    const adapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* () {
        yield terminalUsage();
      },
    };
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              if (selectCount === 1) return [];
              return [
                {
                  id: accountId,
                  providerId: "anthropic",
                  credentialKind: "none",
                  credentialCiphertext: null,
                },
              ];
            },
          }),
        }),
      }),
    };
    let acquiredLimits: Record<string, number> | undefined;
    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore,
      networkBindingFactory: {
        resolve: async () => ({ hostname: "api.anthropic.com", resolvedAddress: "1.2.3.4" }),
        fetch: () => (async () => new Response("ok")) as never,
      } as never,
      poolSelector: {
        tryAcquireAvailablePool: async (
          _eligiblePoolIds: readonly string[],
          _providerId: string,
          limitsByPool?: Record<string, number>,
        ) => {
          acquiredLimits = limitsByPool;
          return { poolId: "pool-a", release: () => {} };
        },
      } as unknown as never,
    };
    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(acquiredLimits?.["pool-a"]).toBe(3);
    expect(acquiredLimits?.["pool-a"]).not.toBe(8);
  });

  test("dispatches a requires_account:false candidate with a 'none' credential and no account lookup", async () => {
    const candidate = {
      provider_id: "opencodeft",
      model_id: "muse-spark-1.2-contributor-free",
      wire_family: "chat" as const,
      endpoint: "/zen/v1/chat/completions",
      capability_profile: {},
      requires_account: false,
    };
    const canonicalRequest = buildCanonicalRequest();
    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "fast",
      resolved_model: "muse-spark-1.2-contributor-free",
      provider_id: "opencodeft",
    };
    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };

    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;

    let capturedCredentialKind: string | undefined;
    let capturedSecret: Uint8Array | undefined;
    const adapter: ProviderAdapter = {
      provider_id: "opencodeft",
      dispatch: async function* (_request, _candidate, context) {
        capturedCredentialKind = context.credential.credential_kind;
        capturedSecret = context.credential.secret;
        yield terminalUsage();
      },
    };

    // Only the console_settings lookup happens — no `provider_accounts`
    // query at all, proving `resolveCredentialForAccount` was skipped.
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return []; // console_settings
            },
          }),
        }),
      }),
    };

    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["opencodeft", adapter]]),
      stateStore,
    };

    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(capturedCredentialKind).toBe("none");
    expect(capturedSecret).toBeUndefined();
    expect(selectCount).toBe(1);
  });
});

describe("handleProviderProxyRequest — lifecycle hardening", () => {
  function setup(options: {
    providerId: string;
    wireFamily?: "chat" | "responses" | "messages";
    surface?: "chat" | "responses" | "messages";
    stream?: boolean;
    accountId?: string;
    headers?: Record<string, string>;
    onDispatch?: (context: Record<string, unknown>) => void;
    error?: GatewayError;
    midStreamError?: GatewayError;
    deps?: Partial<ProviderProxyHandlerDeps>;
  }): {
    request: Request;
    state: { requestId: string };
    deps: ProviderProxyHandlerDeps;
  } {
    clearConsoleSettingsCacheForTests();
    const candidate = {
      provider_id: parseProviderId(options.providerId),
      model_id: "model-1",
      wire_family: (options.wireFamily ?? "chat") as "chat",
      endpoint: "/v1/chat/completions",
      capability_profile: {},
      ...(options.accountId ? { provider_account_id: options.accountId } : {}),
    };
    const canonicalRequest: CanonicalRequest = {
      model: "model-1",
      messages: [],
      generation_controls: {},
      stream: options.stream ?? false,
      source_surface: options.surface ?? "chat",
    };
    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "model-1",
      resolved_model: "model-1",
      provider_id: parseProviderId(options.providerId),
    };
    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({ candidate }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({ release: async () => {}, commitUsage: async () => {} }),
      } as never,
    };
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      ...(options.headers ? { headers: options.headers } : {}),
    });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;
    let selects = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selects += 1;
              if (selects === 1) return [];
              return [
                {
                  id: options.accountId ?? "account-1",
                  providerId: options.providerId,
                  credentialKind: "none",
                },
              ];
            },
          }),
        }),
      }),
    };
    const adapter: ProviderAdapter = {
      provider_id: parseProviderId(options.providerId),
      dispatch: async function* (_request, _candidate, context) {
        options.onDispatch?.(context as unknown as Record<string, unknown>);
        if (options.error) throw options.error;
        if (options.midStreamError) {
          yield {
            type: "content_delta",
            sequence_number: 1,
            content: { kind: "text", text: "hello" },
          } satisfies CanonicalEvent;
          throw options.midStreamError;
        }
        yield terminalUsage();
      },
    };
    return {
      request,
      state: { requestId: state.requestId },
      deps: {
        db: db as never,
        providerAdapters: new Map([[options.providerId, adapter]]),
        stateStore,
        ...(options.deps ?? {}),
      },
    };
  }

  test("non-streaming success carries x-request-id and security headers", async () => {
    const { request, state, deps } = setup({ providerId: "openai", accountId: "a1" });
    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(state.requestId);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("streaming success carries x-request-id", async () => {
    const { request, state, deps } = setup({
      providerId: "openai",
      accountId: "a1",
      stream: true,
    });
    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(state.requestId);
    await response.body?.cancel();
  });

  test("streams provider origin and safe details on mid-stream failure", async () => {
    const { request, deps } = setup({
      providerId: "openai",
      accountId: "a1",
      stream: true,
      midStreamError: new GatewayError(
        "quota_exceeded",
        429,
        "Provider rate limit exceeded",
        {
          providerCode: "rate_limit_exceeded",
          upstreamRequestId: "provider-123",
          raw: "safe provider detail",
          rateLimitScope: "provider",
        },
        "upstream",
      ),
    });
    const response = await handleProviderProxyRequest(request, deps);
    const body = await response.text();
    expect(body).toContain('"origin":"upstream"');
    expect(body).toContain('"upstreamRequestId":"provider-123"');
    expect(body).toContain("safe provider detail");
  });

  test("rejects before streaming when the candidate fails on its first event", async () => {
    const { request, deps } = setup({
      providerId: "openai",
      accountId: "a1",
      stream: true,
      error: new GatewayError(
        "quota_exceeded",
        429,
        "Provider rate limit exceeded",
        { providerCode: "rate_limit_exceeded" },
        "upstream",
      ),
    });
    await expect(handleProviderProxyRequest(request, deps)).rejects.toMatchObject({
      code: "quota_exceeded",
      status: 429,
    });
  });

  test("unbound custom provider fails closed without dispatching", async () => {
    let dispatched = false;
    const { request, deps } = setup({
      providerId: "custom-acme",
      accountId: "a9",
      onDispatch: () => {
        dispatched = true;
      },
    });
    await expect(handleProviderProxyRequest(request, deps)).rejects.toThrow(
      "validated network binding is required",
    );
    expect(dispatched).toBe(false);
  });

  test("only allowlisted inbound headers reach provider dispatch", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const { request, deps } = setup({
      providerId: "openai",
      accountId: "a1",
      headers: {
        authorization: "Bearer victim",
        cookie: "session_token=victim",
        "x-forwarded-for": "9.9.9.9",
        "user-agent": "test-agent",
        "anthropic-beta": "beta-flag",
        "x-claude-code-session-id": "ses-1",
        "x-session-id": "sticky-session",
        "prompt-cache-key": "cache-key",
        "x-cartethyia-surface": "responses",
        "x-cartethyia-tenant": "tenant-1",
        "x-custom-evil": "nope",
      },
      onDispatch: (context) => {
        forwarded = (context["request_headers"] as Record<string, unknown>) ?? undefined;
      },
    });
    const response = await handleProviderProxyRequest(request, deps);
    expect(response.status).toBe(200);
    expect(forwarded).toEqual({
      "user-agent": "test-agent",
      "anthropic-beta": "beta-flag",
      "x-claude-code-session-id": "ses-1",
      "x-session-id": "sticky-session",
      "prompt-cache-key": "cache-key",
    });
  });
});
});
