import { modelsDevCatalog } from "../../../src/providers/discovery/models-dev-catalog";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clearConsoleSettingsCacheForTests } from "../../../src/transport/dispatch/attempt-finalize";
import {
  handleProviderProxyRequest,
  type ProviderProxyHandlerDeps,
} from "../../../src/transport/dispatch/proxy-request";
import {
  createResponsesCompactHandler,
  type ResponsesCompactHandlerDeps,
} from "../../../src/transport/dispatch/responses-compact";
import { isOAuthCredentialInvalidated } from "../../../src/transport/dispatch/retry-policy";
import { ProxyRequestPreparer, type PreparedProxyRequest } from "../../../src/transport/request/preparer";
import type { RouteCandidate } from "../../../src/transport/routing/route-model";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { GatewayError } from "../../../src/transport/gateway-error";
import { type CanonicalEvent, type CanonicalRequest, type UsageRecord } from "../../../src/transport/canonical-model";
import { candidateSupportsRequest, type RequiredCapability } from "../../../src/transport/translation/capabilities";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";
import type { ProviderAdapter } from "../../../src/providers/provider-registry";
import { encryptCredential, setCredentialEncryptionKeyForTesting } from "../../../src/security/crypto";
import { consoleSettings } from "../../../src/persistence/schema";

describe("preparer.test.ts", () => {
const candidate = {
  provider_id: "provider",
  model_id: "example-model",
  wire_family: "chat" as const,
  endpoint: "https://example.test",
  capability_profile: {
    image: true,
    tools: true,
    parallelToolCalls: true,
    reasoning: true,
    reasoningEncryptedContent: true,
    responseJsonObject: true,
    responseJsonSchema: true,
    promptCaching: true,
  },
};

const authorization: ResolvedApiKey = {
  id: "key",
  tenantId: "tenant",
  scopes: [],
  snapshot: { api_key_id: "key", tenant_id: "tenant" },
};

function request(messages: CanonicalRequest["messages"]): CanonicalRequest {
  return {
    model: "example-model",
    messages,
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

function createPreparer(
  admit: () => Promise<{ release: () => Promise<void>; released: boolean }>,
) {
  const snapshot = {
    revision: 1,
    candidates: [candidate],
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
  const deps = {
    snapshotService: { getSnapshot: async () => snapshot },
    routingEngine: {
      // Honors the plan() capability-filter contract like the real
      // RoutingEngine: excludes candidates lacking a required capability so
      // prepare() exercises its degrade-and-replan path.
      plan: async (
        _model: string,
        _snapshot: unknown,
        _tenant: unknown,
        requiredCapabilities?: readonly RequiredCapability[],
      ) => {
        const capable =
          requiredCapabilities === undefined || requiredCapabilities.length === 0
            ? [candidate]
            : [candidate].filter((c) => candidateSupportsRequest(c, requiredCapabilities));
        if (capable.length === 0)
          throw new GatewayError(
            "capability_unsupported",
            400,
            "no eligible route supports this request's capabilities",
            { model: "example-model" },
          );
        return {
          revision: 1,
          candidates: capable,
          requested_model: "example-model",
          resolved_model: "example-model",
          provider_id: "provider",
        };
      },
      reserve: async () => ({
        candidate,
        lease_id: "reservation",
        expires_at: Date.now() + 60_000,
        acquired_at: Date.now(),
      }),
    },
    admissionService: { admit },
  };
  return new ProxyRequestPreparer(deps as never);
}

function toolCall(name: string, args: unknown) {
  return {
    role: "assistant" as const,
    content: [{ kind: "toolCall" as const, call_id: crypto.randomUUID(), name, arguments: args }],
  };
}

test("allows repeated identical assistant tool calls through preparation", async () => {
  let admissions = 0;
  const preparer = createPreparer(async () => {
    admissions += 1;
    return { release: async () => {}, released: false };
  });
  const prepared = await preparer.prepare({
    canonicalRequest: request([
      toolCall("bash", { command: "bun test" }),
      toolCall("bash", { command: "bun test" }),
      toolCall("bash", { command: "bun test" }),
    ]),
    authorization,
    deadlineMs: Date.now() + 10_000,
  });
  expect(prepared.candidate.model_id).toBe("example-model");
  expect(admissions).toBe(0);
});



describe("ProxyRequestPreparer wire-specific generation control preflight", () => {
  test("degrades an unsupported generation control (top_k on a Chat-only candidate) instead of forwarding it", async () => {
    const preparer = createPreparer(async () => ({ release: async () => {}, released: false }));
    const req = request([{ role: "user", content: [{ kind: "text", text: "hi" }] }]);
    const prepared = await preparer.prepare({
      canonicalRequest: {
        ...req,
        generation_controls: { top_k: 40 },
      },
      authorization,
      deadlineMs: Date.now() + 10_000,
    });
    // top_k has no Chat Completions equivalent (Anthropic/Ollama-only); the
    // Chat-only candidate must degrade it away rather than forward it, since
    // downstream Chat serialization would otherwise silently drop or the
    // upstream would reject an unknown field.
    expect(prepared.canonicalRequest.generation_controls.top_k).toBeUndefined();
  });
});

describe("completeAttempt telemetry parity (D3)", () => {
  // `telemetry-model` is not a model the catalog prices, so the repriced cost
  // is unknown (`null`), which is what the analytics `partial` flag counts —
  // not `0`, which would claim the turn was measured as free.
  const FIXTURE_USAGE = {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    uncached_input_tokens: 10,
    output_tokens: 7,
    reasoning_tokens: 0,
    estimated_cost: null,
  };

  function telemetryRouteCandidate(): Record<string, unknown> {
    return {
      provider_id: "openai",
      model_id: "telemetry-model",
      wire_family: "chat",
      endpoint: "/v1/chat/completions",
      capability_profile: {},
      requires_account: false,
    };
  }

  function fixtureAdapter(): ProviderAdapter {
    return {
      provider_id: "openai",
      dispatch: async function* () {
        yield {
          type: "content_delta",
          sequence_number: 1,
          content: { kind: "text", text: "hello" },
        } as CanonicalEvent;
        yield {
          type: "terminal",
          sequence_number: 2,
          state: "complete",
          usage: FIXTURE_USAGE,
        } as CanonicalEvent;
      },
    };
  }

  function stubDb(): unknown {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };
  }

  async function dispatchFixture(stream: boolean, rows: unknown[]): Promise<Response> {
    const candidate = telemetryRouteCandidate();
    const canonicalRequest: CanonicalRequest = {
      model: "telemetry-model",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream,
      source_surface: "chat",
    };
    const preparedRequest = {
      canonicalRequest,
      authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan: {
        revision: 1,
        candidates: [candidate],
        requested_model: "telemetry-model",
        resolved_model: "telemetry-model",
        provider_id: "openai",
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
      },
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      },
    } as unknown as PreparedProxyRequest;
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;
    state.canonicalRequest = canonicalRequest;
    state.authorization = authorization;
    const deps = {
      db: stubDb(),
      providerAdapters: new Map([["openai", fixtureAdapter()]]),
      stateStore,
      telemetryBuffer: {
        enqueue: (row: unknown) => {
          rows.push(row);
        },
      },
    } as unknown as ProviderProxyHandlerDeps;
    return handleProviderProxyRequest(request, deps);
  }

  test("streaming and non-streaming report identical telemetry rows for the same fixture", async () => {
    const rows: unknown[] = [];
    const buffered = await dispatchFixture(false, rows);
    expect(buffered.status).toBe(200);
    await buffered.text();
    const streamed = await dispatchFixture(true, rows);
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");
    await streamed.text();
    expect(rows).toHaveLength(2);
    const [nonStreamRow, streamRow] = rows as Array<Record<string, unknown>>;
    // Volatile per-request fields are normalized; the `stream` flag itself
    // legitimately differs and is asserted separately below.
    if (!nonStreamRow || !streamRow) throw new Error("expected two telemetry rows");
    for (const row of [nonStreamRow, streamRow] as Array<Record<string, unknown>>) {
      expect(row).toMatchObject({ status: "completed", usage: FIXTURE_USAGE });
      delete row["requestId"];
      delete row["latencyMs"];
      delete row["ttfbMs"];
      delete row["tokensPerSec"];
      delete row["firstContentDeltaAtMs"];
      delete row["lastEventAtMs"];
    }
    expect(nonStreamRow["stream"]).toBe(false);
    expect(streamRow["stream"]).toBe(true);
    delete nonStreamRow["stream"];
    delete streamRow["stream"];
    expect(streamRow).toEqual(nonStreamRow);
  });
});

describe("runAttemptLoop — failover accounting", () => {
  function terminalEvent(usage: UsageRecord): CanonicalEvent {
    return { type: "terminal", sequence_number: 0, state: "complete", usage } as CanonicalEvent;
  }

  const gpt5Cost = modelsDevCatalog.costFor("openai", "gpt-5");
  const SUCCESS_USAGE = {
    input_tokens: 5,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    uncached_input_tokens: 5,
    output_tokens: 5,
    reasoning_tokens: 0,
    estimated_cost: ((5 * (gpt5Cost.input ?? 0)) + (5 * (gpt5Cost.output ?? 0))) / 1_000_000,
  };

  test("records the successful attempt's outcome, commits usage per attempt, emits one telemetry row", async () => {
    const accountId = "account-fixed-id";
    const failingRouteCandidate = {
      provider_id: "anthropic",
      model_id: "",
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
    const canonicalRequest: CanonicalRequest = {
      model: "fast",
      messages: [],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
    };
    const commits: unknown[] = [];
    const preparedRequest = {
      canonicalRequest,
      authorization,
      candidate: failingRouteCandidate,
      eligibleRouteCandidates: [failingRouteCandidate, workingRouteCandidate],
      plan: {
        revision: 1,
        candidates: [failingRouteCandidate, workingRouteCandidate],
        requested_model: "fast",
        resolved_model: "",
        provider_id: "anthropic",
      },
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
      },
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: "key",
          released: false,
          commitUsage: async (usage: unknown) => {
            commits.push(usage);
          },
          release: async () => {},
        }),
      },
    } as unknown as PreparedProxyRequest;

    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;
    state.canonicalRequest = canonicalRequest;
    state.authorization = authorization;

    const anthropicAdapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* () {
        throw new Error("upstream 503");
        // eslint-disable-next-line no-unreachable
        yield terminalEvent(SUCCESS_USAGE);
      },
    };
    const openaiAdapter: ProviderAdapter = {
      provider_id: "openai",
      dispatch: async function* () {
        yield terminalEvent(SUCCESS_USAGE);
      },
    };

    const accountRows = [
      {
        id: accountId,
        providerId: "anthropic",
        credentialKind: "none",
        credentialCiphertext: null,
      },
      { id: accountId, providerId: "openai", credentialKind: "none", credentialCiphertext: null },
    ];
    let selectCount = 0;
    let accountIndex = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              if (selectCount === 1) return [];
              const row = accountRows[accountIndex] ?? accountRows[accountRows.length - 1];
              accountIndex += 1;
              return [row];
            },
          }),
        }),
      }),
    };

    const rows: Array<Record<string, unknown>> = [];
    const deps = {
      db,
      providerAdapters: new Map([
        ["anthropic", anthropicAdapter],
        ["openai", openaiAdapter],
      ]),
      stateStore,
      telemetryBuffer: {
        enqueue: (row: Record<string, unknown>) => {
          rows.push(row);
        },
      },
    } as unknown as ProviderProxyHandlerDeps;

    const response = await handleProviderProxyRequest(request, deps);

    expect(response.status).toBe(200);
    // The terminal attempt — not the first, failed one — owns the outcome.
    expect(state.outcome).toMatchObject({ status: "completed", providerId: "openai" });
    expect(state.outcome?.usage).toEqual(SUCCESS_USAGE);
    // Exactly one telemetry row per request, however many candidates it tried.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", providerId: "openai" });
    // Both attempts held a lease, so both reconcile their usage: the failed
    // attempt charges its estimate, the successful one its actual usage.
    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual(SUCCESS_USAGE);
  });
});

describe("createResponsesCompactHandler — shared attempt loop", () => {
  const COMPACT_MODEL = "gpt-5.6-sol";
  const ACCOUNT_ID = "codex-account";
  // The compact route has no upstream usage frame, so it commits its own
  // estimate repriced against the routed model: 10 input + 10 output on
  // `gpt-5.6-sol` at the catalog's global rate (4 / 20 per 1M).
  const ESTIMATED_USAGE = {
    input_tokens: 10,
    cached_input_tokens: "unavailable",
    cache_write_tokens: "unavailable",
    uncached_input_tokens: 10,
    output_tokens: 10,
    reasoning_tokens: "unavailable",
    estimated_cost: ((10 * 4) + (10 * 20)) / 1_000_000,
  };

  beforeAll(() => setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7)));
  afterAll(() => setCredentialEncryptionKeyForTesting(undefined));

  function codexRouteCandidate(modelId: string): RouteCandidate {
    return {
      provider_id: "codex",
      model_id: modelId,
      wire_family: "chat",
      endpoint: "/backend-api/codex/responses/compact",
      capability_profile: {},
      provider_account_id: ACCOUNT_ID,
    };
  }

  /** `provider_accounts` + OAuth-state row the credential resolver reads. */
  function credentialDb() {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: ACCOUNT_ID,
                providerId: "codex",
                credentialKind: "oauth",
                credentialCiphertext: encryptCredential("codex-access-token"),
                refreshCiphertext: null,
                expiresAt: null,
              },
            ],
          }),
        }),
      }),
    };
  }

  function compactHarness(options: {
    readonly candidates: RouteCandidate[];
    readonly compact: () => Promise<Response>;
    readonly rows: Array<Record<string, unknown>>;
    readonly commits: unknown[];
  }) {
    const authorization: ResolvedApiKey = {
      id: "key",
      tenantId: "tenant",
      scopes: [],
      snapshot: { api_key_id: "key", tenant_id: "tenant" },
    };
    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/responses/compact", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.authorization = authorization;
    state.ingressBody = { model: COMPACT_MODEL, input: "summarize" };
    const admissionService = {
      admit: async () => ({
        reservationId: "lease-1",
        apiKeyId: "key",
        released: false,
        commitUsage: async (usage: unknown) => {
          options.commits.push(usage);
        },
        release: async () => {},
      }),
    };
    const routingEngine = {
      reserve: async () => ({
        candidate: options.candidates[0],
        lease_id: "reservation",
        expires_at: Date.now() + 60_000,
        acquired_at: Date.now(),
      }),
      release: async () => {},
    };
    const deps = {
      db: credentialDb(),
      providerAdapters: new Map([
        [
          "codex",
          {
            provider_id: "codex",
            compact: async () => options.compact(),
          },
        ],
      ]),
      proxyPreparer: {
        prepareNativeCompact: async () => ({
          authorization,
          candidates: options.candidates,
          plan: {
            revision: 1,
            candidates: options.candidates,
            requested_model: COMPACT_MODEL,
            resolved_model: COMPACT_MODEL,
            provider_id: "codex",
          },
          estimatedInputTokens: 10,
          estimatedOutputTokens: 10,
          routingEngine,
          admissionService,
        }),
      },
      stateStore,
      telemetryBuffer: {
        enqueue: (row: Record<string, unknown>) => {
          options.rows.push(row);
        },
      },
    } as unknown as ResponsesCompactHandlerDeps;
    return { request, state, handler: createResponsesCompactHandler(deps) };
  }

  test("returns the upstream compaction response and records completion once", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const commits: unknown[] = [];
    const { request, state, handler } = compactHarness({
      candidates: [codexRouteCandidate(COMPACT_MODEL)],
      compact: async () =>
        new Response('{"output":"compacted"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      rows,
      commits,
    });

    const response = await handler({ request });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"output":"compacted"}');
    expect(state.outcome).toMatchObject({
      status: "completed",
      providerId: "codex",
      usage: ESTIMATED_USAGE,
    });
    expect(commits).toEqual([ESTIMATED_USAGE]);
    // The compact body never becomes a canonical request, so the telemetry row
    // carries no canonical model/usage — one row per request either way.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", requestedModel: "unknown" });
  });

  test("fails over to the next Codex candidate on a retryable failure", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const commits: unknown[] = [];
    const attempted: string[] = [];
    const { request, state, handler } = compactHarness({
      candidates: [codexRouteCandidate("gpt-5.6-sol-primary"), codexRouteCandidate(COMPACT_MODEL)],
      compact: async () => {
        attempted.push("call");
        if (attempted.length === 1) throw new GatewayError("quota_exceeded", 429, "rate limited");
        return new Response('{"output":"second"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      rows,
      commits,
    });

    const response = await handler({ request });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"output":"second"}');
    expect(attempted).toHaveLength(2);
    expect(state.outcome).toMatchObject({
      status: "completed",
      providerId: "codex",
      usage: ESTIMATED_USAGE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", requestedModel: "unknown" });
    // Each attempt reconciled the lease it held, repriced against the candidate
    // that ran. The failed candidate's id is not in the catalog, so its
    // estimate is unpriced (`null`) — an honest "unknown", not a fake `$0.00`;
    // the served one carries the model's real rate.
    expect(commits).toEqual([
      { ...ESTIMATED_USAGE, estimated_cost: null },
      ESTIMATED_USAGE,
    ]);
  });
});

describe("handleProviderProxyRequest — tenant compression settings", () => {
  function bigGrep(count = 60): string {
    return Array.from(
      { length: count },
      (_, index) => `src/app.ts:${index + 1}:const value${index} = ${index};`,
    ).join("\n");
  }

  test("applies RTK, content stripping, and thinking normalization before dispatch", async () => {
    clearConsoleSettingsCacheForTests();
    const accountId = "account-compression";
    const candidate = {
      provider_id: "anthropic",
      model_id: "claude-test",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: accountId,
    };
    const grepText = bigGrep();
    const canonicalRequest: CanonicalRequest = {
      model: "fast",
      messages: [
        {
          role: "user",
          content: [
            { kind: "image", payload: { source: { type: "url", url: "https://example.test/x.png" } } },
            { kind: "text", text: "look" },
          ],
        },
        {
          role: "tool",
          content: [{ kind: "toolResult", call_id: "c1", content: grepText }],
        },
      ],
      reasoning: { thinking_type: "enabled", budget_tokens: 1024 },
      generation_controls: {},
      stream: false,
      source_surface: "chat",
    };
    const plan = {
      revision: 1,
      candidates: [candidate],
      requested_model: "fast",
      resolved_model: "claude-test",
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

    let captured: CanonicalRequest | undefined;
    const adapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* (request) {
        captured = request;
        yield {
          type: "terminal",
          sequence_number: 0,
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
        } as CanonicalEvent;
      },
    };

    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === consoleSettings) {
                return [
                  {
                    preferences: {
                      thinkingNormalizationEnabled: true,
                    },
                  },
                ];
              }
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

    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;

    const response = await handleProviderProxyRequest(request, {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore,
    });

    expect(response.status).toBe(200);
    expect(captured).toBeDefined();
    const dispatched = captured as CanonicalRequest;


    const userParts = dispatched.messages[0]?.content ?? [];
    expect(userParts.some((part) => part.kind === "image")).toBe(true);

    // Thinking normalization dropped the provider-native thinking config
    // because the last message is not a user turn.
    expect(dispatched.reasoning?.thinking_type).toBeUndefined();
    expect(dispatched.reasoning?.budget_tokens).toBeUndefined();

  });
});
test("does not force OAuth refresh for CodeBuddy safety-policy 403", () => {
  const error = new GatewayError(
    "authentication_failed",
    403,
    "Provider credential rejected: request illegal; content did not pass the safety review",
    {
      providerCode: "11140",
      credentialEvidence: true,
      raw: '{"code":11140,"msg":"request illegal"}',
    },
    "upstream",
  );
  expect(isOAuthCredentialInvalidated(error)).toBe(false);
});

test("does not force OAuth refresh for a hosted web_search tool failure on 403", () => {
  const error = new GatewayError(
    "authentication_failed",
    403,
    "web_search tool invocation failed: search backend unavailable",
    { credentialEvidence: true, raw: '{"error":"web_search unavailable"}' },
    "upstream",
  );
  expect(isOAuthCredentialInvalidated(error)).toBe(false);
});

describe("ProxyRequestPreparer degradation visibility", () => {
  const degradationAuth: ResolvedApiKey = {
    id: "key",
    tenantId: "tenant",
    scopes: [],
    snapshot: { api_key_id: "key", tenant_id: "tenant" },
  };
  test("tools degradation is reported, not silent", async () => {
    const toolsLess = {
      provider_id: "provider",
      model_id: "example-model",
      wire_family: "chat" as const,
      endpoint: "https://example.test",
      capability_profile: {
        image: true,
        tools: false,
        parallelToolCalls: false,
        reasoning: true,
        reasoningEncryptedContent: true,
        responseJsonObject: true,
        responseJsonSchema: true,
        promptCaching: true,
      },
    };
    const snapshot = {
      revision: 1,
      candidates: [toolsLess],
      aliases: {},
      combos: {},
      created_at: Date.now(),
    };
    const preparer = new ProxyRequestPreparer({
      snapshotService: { getSnapshot: async () => snapshot },
      routingEngine: {
        plan: async (
          _model: string,
          _snapshot: unknown,
          _tenant: unknown,
          requiredCapabilities?: readonly RequiredCapability[],
        ) => {
          const capable = [toolsLess].filter((c) =>
            candidateSupportsRequest(c, requiredCapabilities ?? []),
          );
          if (capable.length === 0)
            throw new GatewayError(
              "capability_unsupported",
              400,
              "no eligible route supports this request's capabilities",
              { model: "example-model" },
            );
          return {
            revision: 1,
            candidates: capable,
            requested_model: "example-model",
            resolved_model: "example-model",
            provider_id: "provider",
          };
        },
        reserve: async () => ({
          candidate: toolsLess,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
      },
      admissionService: { admit: async () => ({ release: async () => {}, released: false }) },
    } as never);
    const prepared = await preparer.prepare({
      canonicalRequest: {
        model: "example-model",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        generation_controls: {},
        stream: false,
        source_surface: "chat",
        tools: [{ name: "get_weather", jsonSchema: { type: "object" } }],
        tool_choice: "auto",
      },
      authorization: degradationAuth,
      deadlineMs: Date.now() + 10_000,
    });
    expect(prepared.degradedCapabilities).toContain("tools");
    expect(prepared.canonicalRequest.tools).toBeUndefined();
    expect(prepared.canonicalRequest.tool_choice).toBeUndefined();
  });
});
});
